import TabView from "./Window";
import PanelGroup from "../panelgroup/PanelGroup";
import React from "react";
import type {
  LayoutNode,
  PanelNode,
  WindowNode,
} from "../utils/serializeLayout";
import { useDockable } from "../store";
import DroppableDivider from "../dndkit/DroppableDivider";
import styles from "./Panel.module.css";

type PanelProps = {
  orientation: "row" | "column";
  children:
    | React.ReactElement<React.ComponentProps<typeof View>>
    | React.ReactElement<React.ComponentProps<typeof View>>[];
  address: number[];
  gap?: number;
  panels: LayoutNode[];
  rootPanels?: LayoutNode[];
};

function countTabs(nodes: LayoutNode[]): number {
  return nodes.reduce((count, node) => {
    if (node.type === "Window") return count + node.children.length;
    if (node.type === "Panel") return count + countTabs(node.children);
    return count;
  }, 0);
}

function countWindows(nodes: LayoutNode[]): number {
  return nodes.reduce((count, node) => {
    if (node.type === "Window") return count + 1;
    if (node.type === "Panel") return count + countWindows(node.children);
    return count;
  }, 0);
}

function PanelView({
  orientation = "row",
  children,
  address,
  gap,
  panels,
  rootPanels,
}: PanelProps) {
  const { dispatch } = useDockable();
  const layoutRoot = rootPanels ?? panels;
  const showAllTabBars =
    countTabs(layoutRoot) > 1 || countWindows(layoutRoot) > 1;

  const sizes = panels.map((panel) => panel.size || 1);

  const childArray = React.Children.toArray(children) as React.ReactElement<
    React.ComponentProps<typeof View>
  >[];

  function handleResizeEnd(sizes: number[]) {
    dispatch({ type: "resize", sizes, address });
  }

  return (
    <>
      <PanelGroup
        orientation={orientation}
        gap={gap}
        sizes={sizes}
        onResizeEnd={handleResizeEnd}
        handleClassName={styles.handle}
        handleComponent={(index: number) => (
          <DroppableDivider address={address} index={index} />
        )}
      >
        {panels.map((panel, index) => {
          if (panel.type === "Window") {
            const panelTabs = panel.children
              .map((tabId) => {
                const tab = childArray.find(({ props }) => props.id === tabId);
                if (!tab) {
                  // Tab element not yet available — the layout (URL) updates
                  // synchronously but tab data may still be loading via an
                  // async query. Skip the missing tab; it will appear on the
                  // next render once data arrives.
                  return null;
                }
                return {
                  id: tab.props.id,
                  name: tab.props.name,
                  content: tab,
                  onClose: tab.props.onClose,
                };
              })
              .filter((t): t is NonNullable<typeof t> => t !== null);
            return (
              <TabView
                id={panel.id}
                tabs={panelTabs}
                hideTabs={!showAllTabBars}
                selected={(panel as WindowNode).selected.toString()}
                orientation={orientation}
                address={address.concat(index)}
              />
            );
          } else {
            const _panel = panel as PanelNode;
            return (
              <PanelView
                key={index}
                orientation={
                  _panel.orientation !== undefined
                    ? _panel.orientation
                    : orientation === "row"
                      ? "column"
                      : "row"
                }
                panels={_panel.children}
                children={children}
                address={address.concat(index)}
                gap={gap}
                rootPanels={layoutRoot}
              />
            );
          }
        })}
      </PanelGroup>
    </>
  );
}

type WindowProps = {
  id: string;
  name: string;
  children: React.ReactNode;
  onClose?: () => void;
};

export const View: React.FC<WindowProps> = ({ children }) => <>{children}</>;

export default PanelView;
