import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import PanelView from "./Panel";
import appReducer from "../reducer";
import serializeLayout, {
  type LayoutNode,
  type PanelNode,
} from "../utils/serializeLayout";
import {
  DndContext,
  useSensor,
  useSensors,
  PointerSensor,
  DragOverlay,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from "@dnd-kit/core";
import {
  StoreContext,
  DockChromeContext,
  DEFAULT_DOCK_CHROME,
  type DockChrome,
} from "../store";
import { dockableCollision } from "../dndkit/dockableCollision";
import DroppableDivider from "../dndkit/DroppableDivider";
import Droppable from "../dndkit/Droppable";
import {
  type MoveTabAction,
  type ReorderTabsAction,
  type SplitWindowAction,
  type InsertPanelAction,
} from "../reducer";
import { type TabProps, type PanelProps, type WindowProps } from "..";
import styles from "./Root.module.css";

type DockableProps = {
  orientation?: "row" | "column";
  layout?: LayoutNode[];
  children:
    | React.ReactElement<PanelProps | WindowProps | TabProps>
    | React.ReactElement<PanelProps | WindowProps | TabProps>[];
  onChange?: (panels: LayoutNode[]) => void;
  gap?: number;
  radius?: number;
  /** Chrome the host lays into the tab bars — see `DockChrome`. */
  chrome?: Partial<DockChrome>;
};

type DockAction = Parameters<typeof appReducer>[1];

const rootPanel = (children: LayoutNode[]): PanelNode => ({
  children,
  id: "root",
  type: "Panel",
  size: 1,
});

/**
 * The dock's layout and its dispatch.
 *
 * Controlled (a `layout` prop): the prop is the only copy of the layout.
 * An action runs the reducer against it and reports the result at once,
 * in the same event — no internal state to sync the prop into, no effect
 * a frame later to report from, no JSON comparisons to tell the two
 * apart. Uncontrolled: the reducer's own state, reported on change.
 */
function useDockableLayout(
  controlledPanels: LayoutNode[] | undefined,
  declarativePanels: LayoutNode[],
  onChange: ((panels: LayoutNode[]) => void) | undefined,
) {
  const controlled = controlledPanels !== undefined;
  const [ownState, ownDispatch] = useReducer(
    appReducer,
    rootPanel(controlledPanels ?? declarativePanels),
  );
  const controlledState = useMemo(
    () => (controlledPanels ? rootPanel(controlledPanels) : null),
    [controlledPanels],
  );
  const state = controlledState ?? ownState;

  // The layout an action applies to: the prop as last rendered, advanced by
  // every action reported since (two actions in one event see each other).
  // Kept current after each commit — before any event can dispatch.
  const latestRef = useRef(state);
  const onChangeRef = useRef(onChange);
  const controlledRef = useRef(controlled);
  useLayoutEffect(() => {
    latestRef.current = state;
    onChangeRef.current = onChange;
    controlledRef.current = controlled;
  });

  const dispatch = useCallback((action: DockAction) => {
    if (!controlledRef.current) return ownDispatch(action);
    const current = latestRef.current;
    const next = appReducer(current, action);
    if (next === current) return;
    latestRef.current = next;
    onChangeRef.current?.(next.children);
  }, []);

  // Uncontrolled only: report the reducer's state after each change.
  const lastReportedRef = useRef(ownState);
  useEffect(() => {
    if (controlled || !onChange) return;
    if (ownState === lastReportedRef.current) return;
    lastReportedRef.current = ownState;
    onChange(ownState.children);
  }, [controlled, ownState, onChange]);

  return { state, dispatch };
}

export function DockableRoot({
  orientation = "row",
  children,
  layout: controledPanels,
  onChange,
  gap = 2,
  radius = 0,
  chrome,
}: DockableProps) {
  const views: React.ReactElement<TabProps>[] = [];
  const [active, setActive] = useState<{
    id: string;
    type: string;
    children: React.ReactNode;
  } | null>(null);

  const childrenArray = React.Children.toArray(
    children,
  ) as React.ReactElement[];

  const declarativePanels = childrenArray.map((child) =>
    serializeLayout(child, views),
  );

  const { state, dispatch } = useDockableLayout(
    controledPanels,
    declarativePanels,
    onChange,
  );

  const store = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  const chromeValue = useMemo(
    () => ({ ...DEFAULT_DOCK_CHROME, ...chrome }),
    [chrome],
  );

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 10,
    },
  });
  const sensors = useSensors(pointerSensor);

  function handleDragStart({ active }: DragStartEvent) {
    const type = active.data.current?.type;
    const children = active.data.current?.children;
    // Nothing may be selectable while a drag is in flight (see styles.css):
    // macOS WKWebView hands mouse gestures over to its native text-selection
    // handling the moment the pointer crosses static user-select:text content
    // (e.g. a chat transcript), which kills the dnd-kit drag. dnd-kit's own
    // selectionchange clearing is too late for that native gesture.
    document.body.setAttribute("data-dockable-dragging", "");
    setActive({ id: active.id.toString(), type, children });
  }

  function handleDragCancel() {
    document.body.removeAttribute("data-dockable-dragging");
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    document.body.removeAttribute("data-dockable-dragging");
    if (!over) return;
    switch (over.data.current?.type) {
      case "tab-bar": {
        return dispatch({
          type: "moveTab",
          tabId: active.id.toString(),
          sourceWindowAddress: active.data.current?.address,
          targetWindowAddress: over.data.current?.address,
        } as MoveTabAction);
      }
      case "tab": {
        if (active.data.current?.parentId === over.data.current?.parentId) {
          return dispatch({
            type: "reorderTabs",
            sourceTabId: active.id.toString(),
            targetTabId: over.id.toString(),
            address: active.data.current?.address,
          } as ReorderTabsAction);
        }
        return dispatch({
          type: "moveTab",
          tabId: active.id.toString(),
          sourceWindowAddress: active.data.current?.address,
          targetWindowAddress: over.data.current?.address,
        } as MoveTabAction);
      }
      case "edge-zone": {
        return dispatch({
          type: "splitWindow",
          tabId: active.id.toString(),
          sourceWindowAddress: active.data.current?.address,
          targetWindowAddress: over.data.current?.address,
          direction: over.data.current.side,
          orientation: over.data.current.orientation,
        } as SplitWindowAction);
      }
      case "insert-panel": {
        return dispatch({
          type: "insertPanel",
          tabId: active.id.toString(),
          sourceAddress: active.data.current?.address,
          targetAddress: over.data.current.address,
        } as InsertPanelAction);
      }
    }
    setActive(null);
  }

  function handleDragOver({ over }: DragOverEvent) {
    if (!over) return;
    console.log(over.data.current?.type);
  }

  function renderEdgeDroppables() {
    return (
      <>
        <div
          className={styles.edgeDroppable}
          style={{
            width: gap + 4,
            top: 0,
            left: 0,
          }}
        >
          <DroppableDivider address={[]} index={-1} />
        </div>
        <div
          className={styles.edgeDroppable}
          style={{
            width: gap + 4,
            right: 0,
            top: 0,
          }}
        >
          <DroppableDivider address={[]} index={state.children.length} />
        </div>
        <div
          className={styles.edgeDroppable}
          style={{
            height: gap + 4,
            left: 0,
            bottom: 0,
          }}
        >
          <Droppable
            id={`bottom-edge`}
            data={{
              type: "edge-zone",
              orientation,
              parentId: "root",
              address: [],
              side: "Bottom",
            }}
            className={styles.edgeDroppableHandle}
            overStyle={{
              backgroundColor: "hsl(var(--ring) / 0.3)",
            }}
          />
        </div>
        <div
          className={styles.edgeDroppable}
          style={{
            height: gap + 4,
            left: 0,
            top: 0,
          }}
        >
          <Droppable
            id={`top-edge`}
            data={{
              type: "edge-zone",
              orientation,
              parentId: "root",
              address: [],
              side: "Top",
            }}
            className={styles.edgeDroppableHandle}
            overStyle={{
              backgroundColor: "hsl(var(--ring) / 0.3)",
            }}
          />
        </div>
      </>
    );
  }

  return (
    <StoreContext.Provider value={store}>
      <DockChromeContext.Provider value={chromeValue}>
      <div
        className={styles.container}
        style={{
          // @ts-expect-error - radius is variable
          "--dockable-radius": radius + "px",
          "--dockable-gap": gap + "px",
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={dockableCollision}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          onDragOver={handleDragOver}
        >
          <PanelView
            orientation={orientation}
            panels={state.children}
            address={[]}
            gap={gap}
          >
            {views}
          </PanelView>

          {createPortal(
            <DragOverlay zIndex={999}>
              {active ? (
                <div
                  style={{
                    overflow: "hidden",
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                  }}
                >
                  {active.children}
                </div>
              ) : null}
            </DragOverlay>,
            document.body,
          )}

          {renderEdgeDroppables()}
        </DndContext>
      </div>
      </DockChromeContext.Provider>
    </StoreContext.Provider>
  );
}
