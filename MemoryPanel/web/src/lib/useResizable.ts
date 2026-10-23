import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Draggable splitter hook
 * @param initial  Initial width (px)
 * @param min      Minimum width (px)
 * @param max      Maximum width (px)
 * @param side     Drag edge: 'left' means the left panel width is adjustable, 'right' means the right panel width is adjustable
 */
export function useResizable(initial: number, min: number, max: number, side: 'left' | 'right' = 'left') {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const previousBodyStyles = useRef<{ cursor: string; userSelect: string } | null>(null);

  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    if (previousBodyStyles.current) {
      document.body.style.cursor = previousBodyStyles.current.cursor;
      document.body.style.userSelect = previousBodyStyles.current.userSelect;
      previousBodyStyles.current = null;
    }
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // A repeated mousedown must not replace the pre-drag style snapshot.
    if (dragging.current) return;
    previousBodyStyles.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW = side === 'left'
        ? Math.max(min, Math.min(max, startW.current + delta))
        : Math.max(min, Math.min(max, startW.current - delta));
      setWidth(newW);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
      endDrag();
    };
  }, [min, max, side, endDrag]);

  return { width, onMouseDown };
}
