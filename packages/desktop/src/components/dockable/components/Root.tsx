import React, { useReducer, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PanelView from "./Panel";
import appReducer from "../reducer";
import serializeLayout, { type LayoutNode } from "../utils/serializeLayout";
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
import { StoreContext } from "../store";
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
};

export function Dockable({
  orientation = "row",
  children,
  layout: controledPanels,
  onChange,
  gap = 2,
  radius = 0,
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

  const [state, dispatch] = useReducer(appReducer, {
    children: controledPanels || declarativePanels,
    id: "root",
    type: "Panel",
    size: 1,
  });

  // Track the last layout JSON we reported to the parent via onChange.
  // We use a serialised string so that the comparison survives the
  // URL → JSON.parse round-trip (which always creates new object refs).
  const lastReportedJsonRef = useRef<string>(
    controledPanels ? JSON.stringify(controledPanels) : "",
  );

  // Sync controlled layout prop into internal reducer state.
  // Only dispatch when the incoming prop is structurally different from
  // what we last reported, which breaks the
  // onChange → setLayout → prop change → setState infinite loop.
  useEffect(() => {
    if (!controledPanels) return;
    const incoming = JSON.stringify(controledPanels);
    if (incoming !== lastReportedJsonRef.current) {
      lastReportedJsonRef.current = incoming;
      dispatch({ type: "setState", children: controledPanels });
    }
  }, [controledPanels]);

  // Report internal state changes to the parent.
  useEffect(() => {
    if (!onChange) return;
    const current = JSON.stringify(state.children);
    if (current !== lastReportedJsonRef.current) {
      lastReportedJsonRef.current = current;
      onChange(state.children);
    }
  }, [state, onChange]);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 10,
    },
  });
  const sensors = useSensors(pointerSensor);

  function handleDragStart({ active }: DragStartEvent) {
    const type = active.data.current?.type;
    const children = active.data.current?.children;
    setActive({ id: active.id.toString(), type, children });
  }

  function handleDragCancel() {
    // console.log("drag cancel");
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
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
              padding: "0 !important",
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
    <StoreContext.Provider value={{ state, dispatch }}>
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
    </StoreContext.Provider>
  );
}
