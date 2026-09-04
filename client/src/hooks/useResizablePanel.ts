import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function useResizablePanel({ storageKey, defaultWidth, min, max }: Options) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0
      ? clamp(stored, min, max)
      : defaultWidth;
  });
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStart.current) return;
      const delta = e.clientX - dragStart.current.x;
      setWidth(clamp(dragStart.current.width + delta, min, max));
    },
    [min, max],
  );

  const handleMouseUp = useCallback(() => {
    dragStart.current = null;
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      dragStart.current = { x: e.clientX, width };
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [width, handleMouseMove, handleMouseUp],
  );

  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  return { width, startDrag };
}
