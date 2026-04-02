"use client";

import * as React from "react";

import {
  BlockSelectionPlugin,
  useBlockSelected,
} from "@platejs/selection/react";
import {
  TablePlugin,
  TableProvider,
  useTableCellElement,
  useTableElement,
} from "@platejs/table/react";
import { PopoverAnchor } from "@radix-ui/react-popover";
import { ListPlus, TrashIcon, SquareX, XSquareIcon } from "lucide-react";
import {
  type TTableCellElement,
  type TTableElement,
  type TTableRowElement,
  KEYS,
  PathApi,
} from "platejs";
import {
  type PlateElementProps,
  PlateElement,
  useComposedRef,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  usePluginOption,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
  withHOC,
} from "platejs/react";
import { useElementSelector } from "platejs/react";

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { Popover, PopoverContent } from "@/components/ui/popover";
import { Toolbar, ToolbarButton, ToolbarGroup } from "./toolbar";

export const TableElement = withHOC(
  TableProvider,
  function TableElement({
    children,
    ...props
  }: PlateElementProps<TTableElement>) {
    const readOnly = useReadOnly();
    const isSelectionAreaVisible = usePluginOption(
      BlockSelectionPlugin,
      "isSelectionAreaVisible",
    );
    const hasControls = !readOnly && !isSelectionAreaVisible;
    const { marginLeft, props: tableProps } = useTableElement();

    const isSelectingTable = useBlockSelected(props.element.id as string);

    const content = (
      <PlateElement
        {...props}
        className={cn(
          "overflow-x-auto py-5",
          hasControls && "-ml-2 *:data-[slot=block-selection]:left-2",
        )}
        style={{ paddingLeft: marginLeft }}
      >
        <div className="group/table relative w-fit">
          <table
            className={cn("mr-0 ml-px table h-px table-fixed border-collapse")}
            {...tableProps}
          >
            <tbody className="min-w-full">{children}</tbody>
          </table>
        </div>
      </PlateElement>
    );

    if (readOnly) {
      return content;
    }

    return <TableFloatingToolbar>{content}</TableFloatingToolbar>;
  },
);

function TableFloatingToolbar({
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  const { tf } = useEditorPlugin(TablePlugin);
  const selected = useSelected();
  const element = useElement<TTableElement>();
  const { props: buttonProps } = useRemoveNodeButton({ element });
  const collapsedInside = useEditorSelector(
    (editor) => selected && editor.api.isCollapsed(),
    [selected],
  );
  const isFocusedLast = useFocusedLast();

  return (
    <Popover open={isFocusedLast && collapsedInside} modal={false}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        asChild
        onOpenAutoFocus={(e) => e.preventDefault()}
        contentEditable={false}
        {...props}
      >
        <Toolbar
          className="scrollbar-hide flex w-auto max-w-[80vw] flex-row overflow-x-auto rounded-md border bg-popover p-1 shadow-md print:hidden"
          contentEditable={false}
        >
          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Insert row before"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  className="-rotate-90"
                >
                  <path d="M14.5 12.5h7" />
                  <path d="M18 16V9" />
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                </svg>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Insert row after"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  className="rotate-90"
                >
                  <path d="M14.5 12.5h7" />
                  <path d="M18 16V9" />
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                </svg>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Delete row"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  className="rotate-90"
                >
                  <path d="M10.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5.5" />
                  <path d="M14.5 18h7" />
                  <path d="M15 3v7.5" />
                  <path d="M9 3v18" />
                </svg>
              </ToolbarButton>
            </ToolbarGroup>
          )}

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Insert column before"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  className="rotate-180"
                >
                  <path d="M14.5 12.5h7" />
                  <path d="M18 16V9" />
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                </svg>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Insert column after"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M14.5 12.5h7" />
                  <path d="M18 16V9" />
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                </svg>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip="Delete column"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M10.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5.5" />
                  <path d="M14.5 18h7" />
                  <path d="M15 3v7.5" />
                  <path d="M9 3v18" />
                </svg>
              </ToolbarButton>
            </ToolbarGroup>
          )}

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton tooltip="Delete table" {...buttonProps}>
                <TrashIcon />
              </ToolbarButton>
            </ToolbarGroup>
          )}
        </Toolbar>
      </PopoverContent>
    </Popover>
  );
}

export function TableRowElement({
  children,
  ...props
}: PlateElementProps<TTableRowElement>) {
  const { element } = props;
  const readOnly = useReadOnly();
  const selected = useSelected();

  return (
    <PlateElement
      {...props}
      as="tr"
      className={cn("group/row")}
      attributes={{
        ...props.attributes,
        "data-selected": selected ? "true" : undefined,
      }}
    >
      {children}
    </PlateElement>
  );
}

export function TableCellElement({
  isHeader,
  ...props
}: PlateElementProps<TTableCellElement> & {
  isHeader?: boolean;
}) {
  const readOnly = useReadOnly();
  const element = props.element;

  const tableId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.table,
  });
  const rowId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.tr,
  });
  const isSelectingTable = useBlockSelected(tableId);
  const isSelectingRow = useBlockSelected(rowId) || isSelectingTable;
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    "isSelectionAreaVisible",
  );

  const { colIndex, colSpan, minHeight, rowIndex, selected, width } =
    useTableCellElement();

  return (
    <PlateElement
      {...props}
      as={isHeader ? "th" : "td"}
      className={cn(
        "h-full overflow-visible border border-border bg-background p-0",
        isHeader && "text-left *:m-0",
      )}
      style={
        {
          maxWidth: width || 240,
          minWidth: width || 120,
        } as React.CSSProperties
      }
      attributes={{
        ...props.attributes,
        colSpan: 1,
        rowSpan: 1,
      }}
    >
      <div
        className="relative z-[1] box-border h-full px-3 py-2"
        style={{ minHeight }}
      >
        {props.children}
      </div>
    </PlateElement>
  );
}

export function TableCellHeaderElement(
  props: React.ComponentProps<typeof TableCellElement>,
) {
  return <TableCellElement {...props} isHeader />;
}
