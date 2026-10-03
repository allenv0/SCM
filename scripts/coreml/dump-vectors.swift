// dump-vectors.swift — Stage C helper: run the compiled native model over a
// directory of f32 CHW tensors and write raw pooler_output vectors as JSON.
// Swift consumes dumped bytes; it never decodes images.
//
//   swiftc -O -parse-as-library -o out/dump-vectors scripts/coreml/dump-vectors.swift
//   ./out/dump-vectors --model out/siglip2-vision-fp16.mlpackage \
//       --compute-units cpu-neural-engine \
//       --tensors out/baseline/tensors --out out/native-vectors.json

import CoreML
import Foundation

struct DumpArgs {
    var modelPath = ""
    var computeUnits = "cpu-neural-engine"
    var tensorsDir = ""
    var outPath = ""
}

func parseDumpArgs() -> DumpArgs {
    var a = DumpArgs()
    var i = 1
    let argv = CommandLine.arguments
    while i < argv.count {
        let k = argv[i]
        let v = i + 1 < argv.count ? argv[i + 1] : ""
        switch k {
        case "--model": a.modelPath = v; i += 2
        case "--compute-units": a.computeUnits = v; i += 2
        case "--tensors": a.tensorsDir = v; i += 2
        case "--out": a.outPath = v; i += 2
        default: i += 1
        }
    }
    return a
}

func units(from s: String) throws -> MLComputeUnits {
    switch s {
    case "all": return .all
    case "cpu-neural-engine", "cpuAndNeuralEngine": return .cpuAndNeuralEngine
    case "cpu-only", "cpuOnly", "cpu": return .cpuOnly
    default: throw NSError(domain: "dump", code: 1, userInfo: [NSLocalizedDescriptionKey: s])
    }
}

@main
struct DumpVectors {
    static func main() throws {
        let args = parseDumpArgs()
        guard !args.modelPath.isEmpty, !args.tensorsDir.isEmpty else {
            FileHandle.standardError.write("usage: --model <mlpackage> --tensors <dir> [--compute-units …] [--out path]\n".data(using: .utf8)!)
            exit(2)
        }
        let compiled = try MLModel.compileModel(at: URL(fileURLWithPath: args.modelPath))
        let cfg = MLModelConfiguration()
        cfg.computeUnits = try units(from: args.computeUnits)
        let model = try MLModel(contentsOf: compiled, configuration: cfg)

        let fm = FileManager.default
        let entries = try fm.contentsOfDirectory(atPath: args.tensorsDir)
            .filter { $0.hasSuffix(".f32") }
            .sorted()
        var rows: [[String: Any]] = []
        for name in entries {
            let url = URL(fileURLWithPath: args.tensorsDir).appendingPathComponent(name)
            let data = try Data(contentsOf: url)
            let n = data.count / 4
            if n != 3 * 224 * 224 {
                FileHandle.standardError.write("skip \(name): \(n) floats\n".data(using: .utf8)!)
                continue
            }
            var pixel = [Float](repeating: 0, count: n)
            pixel.withUnsafeMutableBufferPointer { dest in
                _ = data.copyBytes(to: UnsafeMutableBufferPointer(start: dest.baseAddress, count: n))
            }
            let arr = try MLMultiArray(shape: [1, 3, 224, 224] as [NSNumber], dataType: .float32)
            let ptr = arr.dataPointer.bindMemory(to: Float.self, capacity: n)
            pixel.withUnsafeBufferPointer { src in
                for i in 0..<n { ptr[i] = src[i] }
            }
            let provider = try MLDictionaryFeatureProvider(dictionary: [
                "pixel_values": MLFeatureValue(multiArray: arr),
            ])
            let out = try model.prediction(from: provider)
            guard let multi = out.featureValue(for: "pooler_output")?.multiArrayValue else {
                throw NSError(domain: "dump", code: 7, userInfo: [NSLocalizedDescriptionKey: "missing output"])
            }
            var v = [Float](repeating: 0, count: multi.count)
            let src = multi.dataPointer.bindMemory(to: Float.self, capacity: multi.count)
            for i in 0..<multi.count { v[i] = src[i] }
            var sum = 0.0
            var norm = 0.0
            for x in v {
                sum += Double(x)
                norm += Double(x) * Double(x)
            }
            let id = name.replacingOccurrences(of: ".f32", with: "")
            rows.append([
                "id": id,
                "vec": v,
                "checksum": sum,
                "norm": sqrt(norm),
            ])
            FileHandle.standardError.write("embedded \(id)\n".data(using: .utf8)!)
        }
        let payload: [String: Any] = [
            "computeUnits": args.computeUnits,
            "modelPath": args.modelPath,
            "count": rows.count,
            "vectors": rows,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        if args.outPath.isEmpty {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        } else {
            try data.write(to: URL(fileURLWithPath: args.outPath))
            print("wrote \(args.outPath)")
        }
    }
}
