'use client';

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { ContentNode } from '@/lib/types';

/**
 * Blokken verslepen in de Artikel-tab: in de lopende tekst, binnen een kader, en
 * een kader in of uit.
 *
 * Het artikel heeft twee niveaus. De hoofdtekst is een lijst blokken, en een
 * kader is een blok met zelf weer een lijst blokken. Een plek in het artikel is
 * dus een kader (of `null` voor de hoofdtekst) en een positie in die lijst. Eén
 * regie kent beide niveaus, zodat een blok van het ene naar het andere kan.
 *
 * Tijdens het slepen:
 * - krijgt elk kader dat het blok kan opnemen een stippelrand;
 * - wordt het kader waar de pointer boven hangt oranje, met "In dit kader zetten";
 * - laat een lijn precies zien waar het blok landt, met "Uit het kader halen" als
 *   het een kader verlaat.
 * De boven- en onderrand van een kader betekenen "ervoor" en "erna", het midden
 * "erin". Een kader past niet in een ander kader. Een kader dat leeg raakt,
 * verdwijnt: er valt dan niets meer in te lezen. Een kop in een kader is een blok
 * als elk ander, dus ook die kan erin, eruit en naar een andere plek.
 *
 * Slepen gaat met pointer-events, niet met HTML-drag-and-drop: in een pagina vol
 * contenteditable wil de browser dan tekst slepen. Met de greep in focus doen de
 * pijltjes hetzelfde, en een pijltje dat een kader raakt gaat erin of eruit.
 */

export interface BlockPath {
  /** Het kader (een index in de hoofdtekst), of null voor de hoofdtekst zelf. */
  box: number | null;
  index: number;
}

type Insert = Extract<ContentNode, { type: 'insert' }>;

/** Hoe hoog de rand van een kader is die nog "ervoor" of "erna" betekent. */
const BAND = 22;
/** Hoe dicht bij de rand van het scrollvlak het slepen de pagina meeneemt. */
const EDGE = 72;

// ─── Het verplaatsen zelf ──────────────────────────────────────────────────

/**
 * Het artikel met één blok op een andere plek. `to` is een invoegplek in de lijst
 * zoals die er vóór het verplaatsen uitzag. Het blok zelf blijft hetzelfde object,
 * zodat de greep na afloop terug te vinden is.
 */
export function relocate(content: readonly ContentNode[], from: BlockPath, to: BlockPath): ContentNode[] {
  const next = content.map((node) => (node.type === 'insert' ? { ...node, content: [...node.content] } : node));
  const target = { ...to };
  let node: ContentNode;

  if (from.box == null) {
    [node] = next.splice(from.index, 1);
    if (target.box != null && target.box > from.index) target.box -= 1;
    if (target.box == null && target.index > from.index) target.index -= 1;
  } else {
    [node] = (next[from.box] as Insert).content.splice(from.index, 1);
    if (target.box === from.box && target.index > from.index) target.index -= 1;
  }

  if (target.box == null) next.splice(target.index, 0, node);
  else (next[target.box] as Insert).content.splice(target.index, 0, node);

  return next.filter((n) => !(n.type === 'insert' && !n.content.length));
}

function pathOf(content: readonly ContentNode[], node: ContentNode): BlockPath | null {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === node) return { box: null, index: i };
    const inner = content[i];
    if (inner.type === 'insert') {
      const at = inner.content.indexOf(node);
      if (at >= 0) return { box: i, index: at };
    }
  }
  return null;
}

function nodeAt(content: readonly ContentNode[], path: BlockPath): ContentNode | undefined {
  if (path.box == null) return content[path.index];
  const box = content[path.box];
  return box?.type === 'insert' ? box.content[path.index] : undefined;
}

/** Een plek die het blok laat waar het is. */
function stays(from: BlockPath, slot: BlockPath): boolean {
  return from.box === slot.box && (slot.index === from.index || slot.index === from.index + 1);
}

// ─── De regie ────────────────────────────────────────────────────────────────

interface Drag {
  from: BlockPath;
  slot: BlockPath | null;
}

interface Controller {
  drag: Drag | null;
  content: readonly ContentNode[];
  register: (key: string) => (el: HTMLElement | null) => void;
  start: (path: BlockPath, event: React.PointerEvent<HTMLButtonElement>) => void;
  move: (event: React.PointerEvent<HTMLButtonElement>) => void;
  finish: (commit: boolean) => void;
  step: (path: BlockPath, direction: -1 | 1) => void;
}

const DragContext = createContext<Controller | null>(null);

const listKey = (box: number | null) => (box == null ? 't' : String(box));

export function BlockDragProvider({
  content,
  onChange,
  children
}: {
  content: readonly ContentNode[];
  onChange?: (content: ContentNode[]) => void;
  children: ReactNode;
}) {
  const elements = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointerY = useRef(0);
  const scroller = useRef<HTMLElement | null>(null);
  const focusNode = useRef<ContentNode | null>(null);

  const update = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const register = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) elements.current.set(key, el);
      else elements.current.delete(key);
    },
    []
  );

  const wrappers = useCallback((box: number | null) => {
    const out: HTMLElement[] = [];
    for (let i = 0; ; i++) {
      const el = elements.current.get(`w:${listKey(box)}:${i}`);
      if (!el) return out;
      out.push(el);
    }
  }, []);

  /** De plek onder de pointer: in een kader als die daar middenin hangt, anders in de hoofdtekst. */
  const slotAt = useCallback(
    (y: number, from: BlockPath): BlockPath => {
      const dragged = nodeAt(content, from);
      const midpoints = (els: HTMLElement[]) =>
        els.reduce((slot, el, i) => {
          const box = el.getBoundingClientRect();
          return y > box.top + box.height / 2 ? i + 1 : slot;
        }, 0);

      if (dragged && dragged.type !== 'insert') {
        for (let i = 0; i < content.length; i++) {
          if (content[i].type !== 'insert') continue;
          const frame = elements.current.get(`f:${i}`);
          if (!frame) continue;
          const box = frame.getBoundingClientRect();
          const band = Math.min(BAND, box.height / 4);
          if (y >= box.top + band && y <= box.bottom - band) return { box: i, index: midpoints(wrappers(i)) };
        }
      }
      return { box: null, index: midpoints(wrappers(null)) };
    },
    [content, wrappers]
  );

  const finish = useCallback(
    (commit: boolean) => {
      const current = dragRef.current;
      update(null);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      if (!commit || !current?.slot || !onChange || stays(current.from, current.slot)) return;
      focusNode.current = nodeAt(content, current.from) ?? null;
      onChange(relocate(content, current.from, current.slot));
    },
    [content, onChange, update]
  );

  const start = useCallback(
    (path: BlockPath, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      pointerY.current = event.clientY;
      scroller.current = scrollParent(event.currentTarget);
      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('cursor', 'grabbing');
      update({ from: path, slot: null });
    },
    [update]
  );

  const move = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const current = dragRef.current;
      if (!current) return;
      pointerY.current = event.clientY;
      const slot = slotAt(event.clientY, current.from);
      if (!sameSlot(slot, current.slot)) update({ ...current, slot });
    },
    [slotAt, update]
  );

  /**
   * Eén plek op of neer met het toetsenbord. Een blok dat tegen een kader aan
   * schuift gaat erin; het eerste of laatste blok van een kader gaat eruit.
   */
  const step = useCallback(
    (path: BlockPath, direction: -1 | 1) => {
      if (!onChange) return;
      const node = nodeAt(content, path);
      if (!node) return;
      let slot: BlockPath | null = null;

      if (path.box == null) {
        const neighbour = content[path.index + direction];
        if (!neighbour) return;
        if (neighbour.type === 'insert' && node.type !== 'insert') {
          slot = { box: path.index + direction, index: direction === 1 ? 0 : neighbour.content.length };
        } else {
          slot = { box: null, index: direction === 1 ? path.index + 2 : path.index - 1 };
        }
      } else {
        const box = content[path.box] as Insert;
        const to = path.index + direction;
        slot =
          to < 0
            ? { box: null, index: path.box }
            : to >= box.content.length
              ? { box: null, index: path.box + 1 }
              : { box: path.box, index: direction === 1 ? path.index + 2 : path.index - 1 };
      }
      focusNode.current = node;
      onChange(relocate(content, path, slot));
    },
    [content, onChange]
  );

  // Na een verplaatsing staat de focus op de greep van het blok op zijn nieuwe plek.
  useEffect(() => {
    const node = focusNode.current;
    if (!node) return;
    focusNode.current = null;
    const path = pathOf(content, node);
    if (path) elements.current.get(`h:${listKey(path.box)}:${path.index}`)?.focus();
  }, [content]);

  // Tijdens het slepen: Escape breekt af, en bij de rand scrollt de pagina mee.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
    };
    const timer = window.setInterval(() => {
      const area = scroller.current;
      const current = dragRef.current;
      if (!area || !current) return;
      const box = area.getBoundingClientRect();
      const y = pointerY.current;
      const speed =
        y < box.top + EDGE
          ? -Math.ceil((box.top + EDGE - y) / 4)
          : y > box.bottom - EDGE
            ? Math.ceil((y - box.bottom + EDGE) / 4)
            : 0;
      if (!speed) return;
      area.scrollBy(0, speed);
      const slot = slotAt(y, current.from);
      if (!sameSlot(slot, current.slot)) update({ ...current, slot });
    }, 16);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearInterval(timer);
    };
  }, [dragging, finish, slotAt, update]);

  const controller = useMemo<Controller | null>(
    () => (onChange ? { drag, content, register, start, move, finish, step } : null),
    [onChange, drag, content, register, start, move, finish, step]
  );

  return <DragContext.Provider value={controller}>{children}</DragContext.Provider>;
}

function sameSlot(a: BlockPath | null, b: BlockPath | null): boolean {
  return a?.box === b?.box && a?.index === b?.index;
}

// ─── Wat de weergave gebruikt ────────────────────────────────────────────────

/**
 * Een lijst blokken: de hoofdtekst (`box` null) of de inhoud van een kader. Zonder
 * regie eromheen staan de blokken er kaal, zoals tijdens een run.
 */
export function BlockList({
  box,
  nodes,
  render
}: {
  box: number | null;
  nodes: readonly ContentNode[];
  render: (node: ContentNode, index: number) => ReactNode;
}) {
  const ctl = useContext(DragContext);
  if (!ctl) {
    return (
      <>
        {nodes.map((node, i) => (
          <Fragment key={i}>{render(node, i)}</Fragment>
        ))}
      </>
    );
  }

  const { drag } = ctl;
  const slot = drag?.slot && !stays(drag.from, drag.slot) && drag.slot.box === box ? drag.slot : null;
  const leaving = drag && drag.from.box != null && box == null;

  return (
    <>
      {nodes.map((node, i) => {
        const path = { box, index: i };
        const drop = slot ? (slot.index === i ? 'before' : slot.index === nodes.length && i === nodes.length - 1 ? 'after' : null) : null;
        return (
          <div
            key={i}
            ref={ctl.register(`w:${listKey(box)}:${i}`)}
            className="reader-block"
            data-dragging={drag && drag.from.box === box && drag.from.index === i ? 'true' : undefined}
            data-drop={drop ?? undefined}
            data-label={drop && leaving ? 'Uit het kader halen' : undefined}
          >
            <button
              type="button"
              ref={ctl.register(`h:${listKey(box)}:${i}`)}
              className="reader-handle"
              aria-label={`${box == null ? 'Blok' : 'Blok in het kader'} ${i + 1} van ${nodes.length} verplaatsen`}
              title="Sleep om te verplaatsen, ook in of uit een kader. Of gebruik de pijltjes omhoog en omlaag."
              onPointerDown={(event) => ctl.start(path, event)}
              onPointerMove={ctl.move}
              onPointerUp={() => ctl.finish(true)}
              onPointerCancel={() => ctl.finish(false)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                ctl.step(path, event.key === 'ArrowUp' ? -1 : 1);
              }}
            >
              {Array.from({ length: 6 }, (_, dot) => (
                <i key={dot} />
              ))}
            </button>
            {render(node, i)}
          </div>
        );
      })}
    </>
  );
}

/**
 * Wat een kader nodig heeft om een dropzone te zijn: een ref om zijn rand te meten,
 * en de attributen die laten zien of het een blok kan opnemen en of dat nu gebeurt.
 */
export function useFrameDrop(box: number | null): {
  ref?: (el: HTMLElement | null) => void;
  'data-dropzone'?: 'mogelijk' | 'actief';
  'data-drop'?: 'inside';
  'data-label'?: string;
} {
  const ctl = useContext(DragContext);
  if (!ctl || box == null) return {};
  const { drag, content } = ctl;
  const ref = ctl.register(`f:${box}`);
  const dragged = drag ? nodeAt(content, drag.from) : undefined;
  if (!drag || !dragged || dragged.type === 'insert') return { ref };

  const here = drag.slot?.box === box;
  const empty = (content[box] as Insert | undefined)?.content.length === 0;
  const moving = here && !stays(drag.from, drag.slot as BlockPath);
  return {
    ref,
    'data-dropzone': here ? 'actief' : 'mogelijk',
    ...(moving && empty ? { 'data-drop': 'inside' as const } : {}),
    ...(here && drag.from.box !== box ? { 'data-label': 'In dit kader zetten' } : {})
  };
}

/** Het dichtstbijzijnde element dat zelf scrollt. */
function scrollParent(from: HTMLElement): HTMLElement {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement as HTMLElement;
}
