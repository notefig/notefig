import React from "react";

export type WindowProps = {
  children: React.ReactElement<TabProps> | React.ReactElement<TabProps>[];
  size?: number;
  selected?: number;
};

export function Window(props: WindowProps) {
  return props.children;
}

export type TabProps = {
  id: string;
  name: string;
  children: React.ReactNode;
  onClose?: () => void;
};

export function Tab(props: TabProps) {
  return props.children;
}

export type PanelProps = {
  orientation?: "row" | "column";
  size?: number;
  children:
    | React.ReactElement<PanelProps | WindowProps | TabProps>
    | React.ReactElement<PanelProps | WindowProps | TabProps>[];
};

export function Panel(props: PanelProps) {
  return props.children;
}
