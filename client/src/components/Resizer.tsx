interface Props {
  onMouseDown: (e: React.MouseEvent) => void;
}

export function Resizer({ onMouseDown }: Props) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize hover:bg-indigo-300
        active:bg-indigo-400 transition-colors"
    />
  );
}
