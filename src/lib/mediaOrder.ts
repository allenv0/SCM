/**
 * Display-only media chronology. Library rows and model embedding bins must
 * retain their shared storage order, so the browse grid orders copies of the
 * rows rather than mutating the persisted index.
 */
export function newestMediaFirst<T extends { modifiedAt: number | null }>(
	items: readonly T[],
): T[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				(b.item.modifiedAt ?? Number.NEGATIVE_INFINITY) -
					(a.item.modifiedAt ?? Number.NEGATIVE_INFINITY) || b.index - a.index,
		)
		.map(({ item }) => item);
}
