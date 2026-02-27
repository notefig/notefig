import styles from "./Window.module.css";
import Droppable from "../dndkit/Droppable";
import Tab from "./Tab";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDndContext } from "@dnd-kit/core";
import { useDockable } from "../store";
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
};
function TabView({
  tabs,
  hideTabs = false,
  selected,
  id,
  orientation,
  address,
}: TabViewProps) {
  const { active, over } = useDndContext();
  const { dispatch } = useDockable();

  const isSameWindow = isSame(
    active?.data?.current?.address,
    over?.data?.current?.address,
  );

  const overId =
    (over?.data?.current?.type === "tab" && over?.data?.current?.parentId) ||
    over?.id;

  const activeId =
    (active?.data?.current?.type === "tab" &&
      active?.data?.current?.parentId) ||
    active?.id;

  const currentEdgeZoneSide =
    over?.data?.current?.parentId == id && over?.data?.current?.side;

  // flag for styling when dragging over the tab bar (but not it's own tabBar)
  const isOverAny = overId == id && activeId !== id;

  return (
    <div className={`${styles.container} ${isOverAny ? styles.isOver : ""}`}>
      {!hideTabs && (
        <Droppable
          id={id}
          data={{
            type: "tab-bar",
            address,
          }}
          className="relative flex bg-transparent"
        >
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
          <div style={{ flex: 1 }} />
        </Droppable>
      )}

      <div
        style={{
          overflow: "auto",
          display: "flex",
          flex: 1,
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
