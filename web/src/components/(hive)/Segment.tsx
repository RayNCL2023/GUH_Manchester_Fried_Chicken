import { SEGMENT, SEGMENT_ITEM } from "@/lib/hive/ui";

export default function <T extends string>({
	items,
	value,
	onChange,
	on = "data-[on=true]:bg-white data-[on=true]:text-ink",
}: {
	items: { id: T; label: string; disabled?: boolean }[];
	value: T;
	onChange: (id: T) => void;
	on?: string;
}) {
	return (
		<div className={SEGMENT}>
			{items.map((it) => (
				<button
					key={it.id}
					disabled={it.disabled}
					onClick={() => onChange(it.id)}
					data-on={value === it.id}
					className={`${SEGMENT_ITEM} disabled:opacity-40 ${on}`}
				>
					{it.label}
				</button>
			))}
		</div>
	);
}
