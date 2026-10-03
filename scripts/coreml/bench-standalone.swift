// bench-standalone.swift — Phase 3A Stage B native proof (plan §4).
// Single swiftc -O program, no SPM dependencies.
//
//   swiftc -O -o out/bench-standalone scripts/coreml/bench-standalone.swift
//   ./out/bench-standalone --model out/siglip2-vision-fp16.mlpackage \
//       --iters 50 --warmup 4 --compute-units cpu-neural-engine \
//       --input out/baseline/tensors/<id>.f32
//
// Emits a single JSON object on stdout. compileMs is measured separately
// from loadMs; only the resulting .mlmodelc is loaded with the requested
// computeUnits. A shape/finite smoke prediction runs before timed samples.

import CoreML
import Foundation

struct Args {
    var modelPath: String = ""
    var iters: Int = 50
    var warmup: Int = 4
    var computeUnits: String = "cpu-neural-engine" // all|cpu-neural-engine|cpu-only
    var inputPath: String = ""
    var outFile: String = ""
}

func parseArgs() -> Args {
    var a = Args()
    var i = 1
    let argv = CommandLine.arguments
    while i < argv.count {
        let k = argv[i]
        let v = i + 1 < argv.count ? argv[i + 1] : ""
        switch k {
        case "--model": a.modelPath = v; i += 2
        case "--iters": a.iters = Int(v) ?? 50; i += 2
        case "--warmup": a.warmup = Int(v) ?? 4; i += 2
        case "--compute-units": a.computeUnits = v; i += 2
        case "--input": a.inputPath = v; i += 2
        case "--out": a.outFile = v; i += 2
        default: i += 1
        }
    }
    return a
}

func computeUnits(from s: String) throws -> MLComputeUnits {
    switch s {
    case "all": return .all
    case "cpu-neural-engine", "cpuAndNeuralEngine", "cpu+ne": return .cpuAndNeuralEngine
    case "cpu-only", "cpuOnly", "cpu": return .cpuOnly
    case "cpu-and-gpu": return .cpuAndGPU
    default:
        throw NSError(
            domain: "bench", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "unknown compute units \(s)"]
        )
    }
}

func percentile(_ sorted: [Double], _ p: Double) -> Double {
    if sorted.isEmpty { return Double.nan }
    let idx = min(sorted.count - 1, max(0, Int((Double(sorted.count) * p).rounded(.up)) - 1))
    return sorted[idx]
}

func checksum(_ v: [Float]) -> Double {
    var s = 0.0
    for x in v { s += Double(x) }
    return s
}

@main
struct Bench {
    static func main() throws {
        let args = parseArgs()
        guard !args.modelPath.isEmpty else {
            FileHandle.standardError.write("usage: --model <mlpackage> [--iters N] [--warmup N] [--compute-units all|cpu-neural-engine|cpu-only] [--input f32-chw-bin]\n".data(using: .utf8)!)
            exit(2)
        }
        let modelURL = URL(fileURLWithPath: args.modelPath)
        let inputURL = args.inputPath.isEmpty ? nil : URL(fileURLWithPath: args.inputPath)
        let units = try computeUnits(from: args.computeUnits)

        // ---- compile ----
        FileHandle.standardError.write("compiling \(modelURL.path) …\n".data(using: .utf8)!)
        let compileStart = Date()
        let compiledURL: URL
        do {
            compiledURL = try MLModel.compileModel(at: modelURL)
        } catch {
            FileHandle.standardError.write("compile failed: \(error)\n".data(using: .utf8)!)
            exit(3)
        }
        let compileMs = Date().timeIntervalSince(compileStart) * 1000.0
        FileHandle.standardError.write("compiled in \(compileMs) ms → \(compiledURL.path)\n".data(using: .utf8)!)

        // ---- load (compiled .mlmodelc only) ----
        FileHandle.standardError.write("loading computeUnits=\(args.computeUnits) …\n".data(using: .utf8)!)
        let config = MLModelConfiguration()
        config.computeUnits = units
        let loadStart = Date()
        let model: MLModel
        do {
            model = try MLModel(contentsOf: compiledURL, configuration: config)
        } catch {
            FileHandle.standardError.write("load failed: \(error)\n".data(using: .utf8)!)
            exit(4)
        }
        let loadMs = Date().timeIntervalSince(loadStart) * 1000.0
        FileHandle.standardError.write("loaded in \(loadMs) ms\n".data(using: .utf8)!)

        // ---- inspect I/O ----
        let desc = model.modelDescription
        let inNames = desc.inputDescriptionsByName.keys.sorted()
        let outNames = desc.outputDescriptionsByName.keys.sorted()
        guard inNames.contains("pixel_values"), outNames.contains("pooler_output") else {
            FileHandle.standardError.write("unexpected feature names in=\(inNames) out=\(outNames)\n".data(using: .utf8)!)
            exit(5)
        }

        // ---- load input bytes ----
        var pixel = [Float](repeating: 0, count: 1 * 3 * 224 * 224)
        if let inputURL = inputURL {
            let data = try Data(contentsOf: inputURL)
            let n = data.count / MemoryLayout<Float>.size
            if n != pixel.count {
                FileHandle.standardError.write("input length \(data.count) bytes != \(pixel.count * 4)\n".data(using: .utf8)!)
                exit(6)
            }
            pixel.withUnsafeMutableBufferPointer { dest in
                _ = data.copyBytes(to: UnsafeMutableBufferPointer(start: dest.baseAddress, count: n))
            }
        } else {
            // Deterministic synthetic CHW tensor when no dump is supplied.
            for i in 0..<pixel.count {
                let t = Float(i) / Float(pixel.count)
                pixel[i] = t * 2.0 - 1.0
            }
        }

        func makeInput() throws -> MLDictionaryFeatureProvider {
            let shape: [NSNumber] = [1, 3, 224, 224]
            let arr = try MLMultiArray(shape: shape, dataType: .float32)
            let n = pixel.count
            let ptr = arr.dataPointer.bindMemory(to: Float.self, capacity: n)
            pixel.withUnsafeBufferPointer { src in
                for i in 0..<n { ptr[i] = src[i] }
            }
            let provider = try MLDictionaryFeatureProvider(dictionary: [
                "pixel_values": MLFeatureValue(multiArray: arr),
            ])
            return provider
        }

        func predictOnce() throws -> [Float] {
            let out = try model.prediction(from: try makeInput())
            guard let multi = out.featureValue(for: "pooler_output")?.multiArrayValue else {
                throw NSError(domain: "bench", code: 7, userInfo: [NSLocalizedDescriptionKey: "missing pooler_output"])
            }
            let n = multi.count
            if n != 768 {
                throw NSError(domain: "bench", code: 8, userInfo: [NSLocalizedDescriptionKey: "pooler_output length \(n) != 768"])
            }
            var v = [Float](repeating: 0, count: n)
            let src = multi.dataPointer.bindMemory(to: Float.self, capacity: n)
            for i in 0..<n {
                let x = src[i]
                if !x.isFinite {
                    throw NSError(domain: "bench", code: 9, userInfo: [NSLocalizedDescriptionKey: "non-finite at \(i)"])
                }
                v[i] = x
            }
            return v
        }

        // ---- smoke ----
        let smokeVec: [Float]
        do {
            smokeVec = try predictOnce()
        } catch {
            FileHandle.standardError.write("smoke failed: \(error)\n".data(using: .utf8)!)
            exit(10)
        }
        let smokeSum = checksum(smokeVec)

        // ---- warmup + timed samples ----
        FileHandle.standardError.write("warmup \(args.warmup) …\n".data(using: .utf8)!)
        do {
            for _ in 0..<args.warmup {
                _ = try predictOnce()
            }
        } catch {
            FileHandle.standardError.write("warmup failed: \(error)\n".data(using: .utf8)!)
            exit(11)
        }
        FileHandle.standardError.write("timing \(args.iters) …\n".data(using: .utf8)!)
        var samples = [Double]()
        samples.reserveCapacity(args.iters)
        var lastOut = smokeVec
        do {
            for _ in 0..<args.iters {
                let t0 = Date()
                lastOut = try predictOnce()
                samples.append(Date().timeIntervalSince(t0) * 1000.0)
            }
        } catch {
            FileHandle.standardError.write("timed run failed: \(error)\n".data(using: .utf8)!)
            exit(12)
        }
        let sorted = samples.sorted()
        let p50 = percentile(sorted, 0.50)
        let p95 = percentile(sorted, 0.95)
        let outSum = checksum(lastOut)

        // ---- optional baseline input checksum for parity (Stage C) ----
        var inputSha = ""
        if let inputURL = inputURL {
            let d = try Data(contentsOf: inputURL)
            // cheap FNV-1a 64 as a stable checksum (not cryptographic)
            var h: UInt64 = 0xcbf2_9ce4_8422_2325
            for b in d {
                h ^= UInt64(b)
                h = h &* 0x0000_0100_0000_01b3
            }
            inputSha = String(format: "%016llx", h)
        }

        let result: [String: Any] = [
            "ok": true,
            "computeUnits": args.computeUnits,
            "compileMs": compileMs,
            "loadMs": loadMs,
            "modelPath": args.modelPath,
            "compiledPath": compiledURL.path,
            "inputPath": args.inputPath,
            "inputChecksum": inputSha,
            "iters": args.iters,
            "warmup": args.warmup,
            "samplesMs": samples,
            "p50Ms": p50,
            "p95Ms": p95,
            "minMs": sorted.first ?? Double.nan,
            "maxMs": sorted.last ?? Double.nan,
            "outputChecksum": outSum,
            "smokeChecksum": smokeSum,
            "outputDim": lastOut.count,
            "inputNames": inNames,
            "outputNames": outNames,
            "earlyStopRecommended": p50 > 60.0,
        ]
        let data = try JSONSerialization.data(
            withJSONObject: result,
            options: [.prettyPrinted, .sortedKeys]
        )
        if args.outFile.isEmpty {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        } else {
            try data.write(to: URL(fileURLWithPath: args.outFile))
            FileHandle.standardOutput.write("wrote \(args.outFile)\n".data(using: .utf8)!)
        }
    }
}
