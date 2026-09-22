import { SHELL_CHROME_WASH_CLASS } from "@/components/titlebar";
import styles from "./Window.module.css";
import Droppable from "../dndkit/Droppable";
import Tab from "./Tab";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDndContext } from "@dnd-kit/core";
import { useDockable, useDockChrome } from "../store";
import { ScrollArea } from "@notefig/ui/scroll-area";
import { cn } from "@notefig/ui/utils";
import { dropZoneProps, getProtocolContext } from "@/utils/drag-protocol";
export type tabObject = {
  id: string;
  name: string;
  content: React.ReactNode;
  renderTabs?: boolean;
  onClose?: () => void;
};

export type tabGroupObject = tabObject[];

function isSame(activeAddress: number[], overAddress: number[]) {
  if (!activeAddress || !overAddress) return false;
  return activeAddress.every(
    (value: number, index: number) => value === overAddress[index],
  );
}

type TabViewProps = {
  tabs: tabGroupObject;
  hideTabs?: boolean;
  selected: string;
  id: string;
  orientation: "row" | "column";
  address: number[];
  atEnd?: boolean;
};

/** Either end of a drag (`active` or `over`) — only the shared shape. */
type DragEntry = Pick<
  NonNullable<ReturnType<typeof useDndContext>["active"]>,
  "id" | "data"
> | null;

/** The window id a drag entry belongs to: a tab's parent window, else the
 *  entry's own id (a window being dragged). */
function dragWindowId(entry: DragEntry) {
  const data = entry?.data?.current;
  return (data?.type === "tab" && data?.parentId) || entry?.id;
}

/** Derived drag state for the tab bar: same-window check, the edge zone
 *  being hovered, and whether a FOREIGN drag is over this bar (its own
 *  tabs don't count). */
function deriveDragState(active: DragEntry, over: DragEntry, id: string) {
  const isSameWindow = isSame(
    active?.data?.current?.address,
    over?.data?.current?.address,
  );
  const currentEdgeZoneSide =
    over?.data?.current?.parentId == id && over?.data?.current?.side;
  const isOverAny = dragWindowId(over) == id && dragWindowId(active) !== id;
  return { isSameWindow, currentEdgeZoneSide, isOverAny };
}

/** A file dropped on the tab bar opens (or moves) as a tab of this window. */
function openDroppedFile(
  payload: { fileType: string; path: string },
  windowId: string,
): void {
  if (payload.fileType !== "file") return;
  getProtocolContext().openFile?.({
    tabId: payload.path,
    intent: "new-tab",
    targetWindowId: windowId,
    moveIfOpen: true,
  });
}

function TabView({
  tabs,
  hideTabs = false,
  selected,
  id,
  orientation,
  address,
  atEnd = false,
}: TabViewProps) {
  const { active, over } = useDndContext();
  const { dispatch } = useDockable();
  const { tabBarLeading, tabBarTrailing, tabBarLeadingActive, endInset } =
    useDockChrome();
  const { isSameWindow, currentEdgeZoneSide, isOverAny } = deriveDragState(
    active,
    over,
    id,
  );
  // The top-left window (first child at every level) is the dock's header
  // row: it hosts the leading chrome and always shows its bar, even with
  // a single tab, so the content never jumps when that chrome comes and
  // goes with the sidebar.
  const isTopLeft = address.every((index) => index === 0);
  const leading = isTopLeft ? tabBarLeading : null;
  // The top bar at the reading direction's end — physically top-left in
  // RTL — keeps the macOS lights clear.
  const endSpacer = atEnd && endInset !== null ? endInset : null;
  const trailing = atEnd ? tabBarTrailing : null;

  return (
    <div
      className={`${styles.container} ${isOverAny ? styles.isOver : ""}`}
      data-dockable-window-id={id}
    >
      {(!hideTabs || isTopLeft) && (
        <Droppable
          id={id}
          data={{
            type: "tab-bar",
            address,
          }}
          data-testid="tab-bar"
          {...dropZoneProps({
            accepts: ["file"],
            onDrop: (payload) => openDroppedFile(payload, id),
          })}
          className={cn(
            // Each window's tab bar is its own floating strip. Its outer
            // height is the shell's header row plus the card border it
            // matches, so the collapsed sidebar header laid into the
            // top-left strip lines up with the open card's header — and
            // that strip drops its start margin to sit where the card was.
            "relative flex min-w-0 h-[calc(var(--shell-header-height,2.25rem)+2px)] shrink-0 rounded-lg border border-border bg-card overflow-clip transition-[margin] duration-200 ease-out motion-reduce:transition-none",
            SHELL_CHROME_WASH_CLASS,
            isTopLeft && tabBarLeadingActive
              ? "ms-0 me-2 w-[calc(100%-0.5rem)]"
              : "mx-2 w-[calc(100%-1rem)]",
            "data-[mtr-drop-over=true]:border-ring",
            "data-[mtr-drop-over=true]:shadow-[0_0_0_1px_hsl(var(--ring))_inset]",
          )}
        >
          {leading}
          <ScrollArea className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex h-full items-stretch">
              <SortableContext
                items={tabs.map((tab) => tab.id)}
                strategy={horizontalListSortingStrategy}
              >
                {tabs.map((tab) => (
                  <Tab
                    key={tab.id}
                    id={tab.id}
                    parentId={id}
                    name={tab.name}
                    selected={tab.id === selected}
                    address={address}
                    onClick={() =>
                      dispatch({
                        type: "selectTab",
                        tabId: tab.id,
                        address,
                      })
                    }
                    onClose={tab.onClose}
                  />
                ))}
              </SortableContext>
            </div>
          </ScrollArea>
          {endSpacer !== null && (
            <div
              data-tauri-drag-region
              className="shrink-0"
              style={{ WebkitAppRegion: "drag", width: endSpacer } as React.CSSProperties}
            />
          )}
          {trailing}
        </Droppable>
      )}

      <div
        className="px-2"
        style={{
          overflow: "clip",
          display: "flex",
          flex: 1,
          // Without this the content minimum wins over the flex sizing in
          // the column container and this box grows to its content's full
          // height — the editor's own overflow-auto wrapper then never
          // constrains, and nothing below the fold is scrollable. The old
          // overflow: hidden masked it by being a scroll port that
          // scrollIntoView could move; clip is not.
          minHeight: 0,
        }}
      >
        {tabs.find((tab) => tab.id === selected)?.content}
      </div>

      <DroppableTargets
        id={id}
        currentEdge={currentEdgeZoneSide}
        orientation={orientation}
        address={address}
        hide={isSameWindow && tabs.length == 1}
      />
    </div>
  );
}

type DroppableTargetsProps = {
  id: string;
  currentEdge: string;
  orientation: "row" | "column";
  address: number[];
  hide: boolean;
};
function DroppableTargets({
  id,
  currentEdge,
  address,
  orientation,
  hide,
}: DroppableTargetsProps) {
  const commonData = {
    type: "edge-zone",
    orientation,
    parentId: id,
    address,
  };
  return (
    <>
      <Droppable
        className={[
          styles.edgeZone,
          styles.edgeZoneLeft,
          currentEdge === "Left" && !hide ? styles.edgeZoneHover : "",
        ].join(" ")}
        id={`${id}-split-left`}
        data={{
          ...commonData,
          side: "Left",
        }}
      />
      <Droppable
        className={[
          styles.edgeZone,
          styles.edgeZoneRight,
          currentEdge === "Right" && !hide ? styles.edgeZoneHover : "",
        ].join(" ")}
        id={`${id}-split-right`}
        data={{
          ...commonData,
          side: "Right",
        }}
      />
      <Droppable
        className={[
          styles.edgeZone,
          styles.edgeZoneTop,
          currentEdge === "Top" && !hide ? styles.edgeZoneHover : "",
        ].join(" ")}
        id={`${id}-split-top`}
        data={{
          ...commonData,
          side: "Top",
        }}
      />
      <Droppable
        className={[
          styles.edgeZone,
          styles.edgeZoneBottom,
          currentEdge === "Bottom" && !hide ? styles.edgeZoneHover : "",
        ].join(" ")}
        id={`${id}-split-bottom`}
        data={{
          ...commonData,
          side: "Bottom",
        }}
      />
    </>
  );
}

export default TabView;
