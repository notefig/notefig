import { DockableRoot } from "./components/Root";
import { Panel, Window, Tab } from "./primitives";

export type { LayoutNode } from "./utils/serializeLayout";
export { Panel, Window, Tab };
export type { PanelProps, WindowProps, TabProps } from "./primitives";

export const Dockable = {
  Root: DockableRoot,
  Panel,
  Window,
  Tab,
};
