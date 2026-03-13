import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { cn } from "@/lib/utils";
import { isTauri } from "@/utils/platform";
import { platformAdapter } from "@/adapters";
import type { ContextMenuItem as NativeMenuItemDescriptor } from "@/adapters/platform-adapter.interface";

const CONTEXT_MENU_ITEM_TYPE = Symbol("ContextMenuItem");
const CONTEXT_MENU_SEPARATOR_TYPE = Symbol("ContextMenuSeparator");
const CONTEXT_MENU_SUB_TYPE = Symbol("ContextMenuSub");
const CONTEXT_MENU_CONTENT_TYPE = Symbol("ContextMenuContent");
const CONTEXT_MENU_GROUP_TYPE = Symbol("ContextMenuGroup");

function extractTextContent(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextContent).join("");
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    return extractTextContent(props.children as React.ReactNode);
  }
  return "";
}
function extractNativeItems(
  children: React.ReactNode,
  prefix = "",
): { items: NativeMenuItemDescriptor[]; handlers: Map<string, () => void> } {
  const items: NativeMenuItemDescriptor[] = [];
  const handlers = new Map<string, () => void>();
  let counter = 0;

  function walk(node: React.ReactNode, labelPrefix: string): void {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;

      const type = child.type as any;
      const props = child.props as Record<string, unknown>;
      const menuType: symbol | undefined = type?.__menuType;

      if (
        menuType === CONTEXT_MENU_CONTENT_TYPE ||
        menuType === CONTEXT_MENU_GROUP_TYPE
      ) {
        walk(props.children as React.ReactNode, labelPrefix);
        return;
      }

      if (menuType === CONTEXT_MENU_SEPARATOR_TYPE) {
        items.push({ type: "separator" });
        return;
      }

      if (menuType === CONTEXT_MENU_ITEM_TYPE) {
        const id = `native-item-${counter++}`;
        const label =
          labelPrefix +
          extractTextContent(props.children as React.ReactNode).trim();
        const disabled = props.disabled === true;
        const onSelect =
          typeof props.onSelect === "function"
            ? (props.onSelect as () => void)
            : undefined;
        const onClick =
          typeof props.onClick === "function"
            ? (props.onClick as () => void)
            : undefined;
        const handler = onSelect ?? onClick;

        items.push({ type: "item", id, label, disabled });
        if (handler) handlers.set(id, handler);
        return;
      }

      if (menuType === CONTEXT_MENU_SUB_TYPE) {
        let subLabel = "";
        let subContentChildren: React.ReactNode = null;

        React.Children.forEach(
          props.children as React.ReactNode,
          (subChild) => {
            if (!React.isValidElement(subChild)) return;
            const subType = (subChild.type as any)?.__menuType ?? subChild.type;
            const subProps = subChild.props as Record<string, unknown>;

            if (
              subType === ContextMenuPrimitive.SubTrigger ||
              (subChild.type as any)?.displayName ===
                ContextMenuPrimitive.SubTrigger.displayName
            ) {
              subLabel = extractTextContent(
                subProps.children as React.ReactNode,
              ).trim();
            }
            if (
              typeof subType === "object" &&
              subType?.render?.displayName ===
                ContextMenuPrimitive.SubTrigger.displayName
            ) {
              subLabel = extractTextContent(
                subProps.children as React.ReactNode,
              ).trim();
            }
            // Detect by displayName on the function
            if (
              typeof subType === "function" &&
              subType.displayName ===
                ContextMenuPrimitive.SubTrigger.displayName
            ) {
              subLabel = extractTextContent(
                subProps.children as React.ReactNode,
              ).trim();
            }
            if (
              subType === ContextMenuPrimitive.SubContent ||
              (subChild.type as any)?.displayName ===
                ContextMenuPrimitive.SubContent.displayName
            ) {
              subContentChildren = subProps.children as React.ReactNode;
            }
            if (
              typeof subType === "object" &&
              subType?.render?.displayName ===
                ContextMenuPrimitive.SubContent.displayName
            ) {
              subContentChildren = subProps.children as React.ReactNode;
            }
            if (
              typeof subType === "function" &&
              subType.displayName ===
                ContextMenuPrimitive.SubContent.displayName
            ) {
              subContentChildren = subProps.children as React.ReactNode;
            }
          },
        );

        const prefix = subLabel ? `${labelPrefix}${subLabel} > ` : labelPrefix;
        if (subContentChildren) {
          items.push({ type: "separator" });
          walk(subContentChildren, prefix);
          items.push({ type: "separator" });
        }
        return;
      }

      if (props.children) {
        walk(props.children as React.ReactNode, labelPrefix);
      }
    });
  }

  walk(children, prefix);

  const cleaned: NativeMenuItemDescriptor[] = [];
  for (const item of items) {
    if (item.type === "separator") {
      if (cleaned.length === 0) continue;
      if (cleaned[cleaned.length - 1]?.type === "separator") continue;
    }
    cleaned.push(item);
  }
  if (cleaned.length > 0 && cleaned[cleaned.length - 1]?.type === "separator") {
    cleaned.pop();
  }

  return { items: cleaned, handlers };
}

const ContextMenu = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root> & {
    children: React.ReactNode;
  }
>(function ContextMenu(props, _ref) {
  const { children, onOpenChange, ...rest } = props;

  if (!isTauri()) {
    return (
      <ContextMenuPrimitive.Root onOpenChange={onOpenChange} {...rest}>
        {children}
      </ContextMenuPrimitive.Root>
    );
  }

  let triggerElement: React.ReactElement | null = null;
  let contentElement: React.ReactElement | null = null;
  const otherChildren: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      otherChildren.push(child);
      return;
    }
    const type = child.type as any;
    const menuType: symbol | undefined = type?.__menuType;

    if (
      type === ContextMenuPrimitive.Trigger ||
      type?.displayName === ContextMenuPrimitive.Trigger.displayName
    ) {
      triggerElement = child;
    } else if (menuType === CONTEXT_MENU_CONTENT_TYPE) {
      contentElement = child;
    } else {
      otherChildren.push(child);
    }
  });

  const capturedContent = contentElement as React.ReactElement | null;
  const capturedTrigger = triggerElement as React.ReactElement | null;

  const handleContextMenu = React.useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      onOpenChange?.(true);

      if (!capturedContent) {
        onOpenChange?.(false);
        return;
      }

      const contentProps = capturedContent.props as Record<string, unknown>;
      const { items, handlers } = extractNativeItems(
        contentProps.children as React.ReactNode,
      );

      if (items.length === 0) {
        onOpenChange?.(false);
        return;
      }

      const selectedId = await platformAdapter.showContextMenu(items, {
        x: e.clientX,
        y: e.clientY,
      });

      if (selectedId && handlers.has(selectedId)) {
        handlers.get(selectedId)!();
      }

      onOpenChange?.(false);
    },
    [capturedContent, onOpenChange],
  );

  // On Tauri we also need to handle the trigger's own onContextMenu if present
  const triggerProps = capturedTrigger
    ? (capturedTrigger.props as Record<string, unknown>)
    : {};
  const originalOnContextMenu = triggerProps.onContextMenu as
    | ((e: React.MouseEvent) => void)
    | undefined;

  // Wrap the trigger: if it uses `asChild`, we wrap its single child; otherwise wrap the trigger element
  const renderTrigger = () => {
    if (!capturedTrigger) return null;

    const triggerP = capturedTrigger.props as {
      asChild?: boolean;
      children?: React.ReactNode;
    };

    if (triggerP.asChild && React.isValidElement(triggerP.children)) {
      // Wrap the asChild's child element
      const innerChild = triggerP.children as React.ReactElement;
      const innerProps = innerChild.props as Record<string, unknown>;
      return React.cloneElement(innerChild, {
        ...innerProps,
        onContextMenu: (e: React.MouseEvent) => {
          // Let the trigger's own handler run first (e.g. BlockContextMenu's handler)
          originalOnContextMenu?.(e);
          if (!e.defaultPrevented) {
            handleContextMenu(e);
          }
        },
      } as any);
    }

    return (
      <div
        onContextMenu={(e) => {
          originalOnContextMenu?.(e);
          if (!e.defaultPrevented) {
            handleContextMenu(e);
          }
        }}
      >
        {triggerP.children}
      </div>
    );
  };

  return (
    <>
      {renderTrigger()}
      {otherChildren}
    </>
  );
}) as any; // Cast since Radix Root doesn't use forwardRef the same way

// ---------------------------------------------------------------------------
// ContextMenuTrigger – on Tauri we just pass through; the Root handles interception
// ---------------------------------------------------------------------------

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

// ---------------------------------------------------------------------------
// ContextMenuGroup
// ---------------------------------------------------------------------------

const ContextMenuGroup = ContextMenuPrimitive.Group;
(ContextMenuGroup as any).__menuType = CONTEXT_MENU_GROUP_TYPE;

// ---------------------------------------------------------------------------
// ContextMenuPortal
// ---------------------------------------------------------------------------

const ContextMenuPortal = ContextMenuPrimitive.Portal;

// ---------------------------------------------------------------------------
// ContextMenuSub
// ---------------------------------------------------------------------------

const ContextMenuSub = ContextMenuPrimitive.Sub;
(ContextMenuSub as any).__menuType = CONTEXT_MENU_SUB_TYPE;

// ---------------------------------------------------------------------------
// ContextMenuRadioGroup
// ---------------------------------------------------------------------------

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

// ---------------------------------------------------------------------------
// ContextMenuSubTrigger
// ---------------------------------------------------------------------------

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

// ---------------------------------------------------------------------------
// ContextMenuSubContent
// ---------------------------------------------------------------------------

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-context-menu-content-transform-origin]",
      className,
    )}
    {...props}
  />
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

// ---------------------------------------------------------------------------
// ContextMenuContent
// ---------------------------------------------------------------------------

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 max-h-[--radix-context-menu-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-context-menu-content-transform-origin]",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;
(ContextMenuContent as any).__menuType = CONTEXT_MENU_CONTENT_TYPE;

// ---------------------------------------------------------------------------
// ContextMenuItem
// ---------------------------------------------------------------------------

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;
(ContextMenuItem as any).__menuType = CONTEXT_MENU_ITEM_TYPE;

// ---------------------------------------------------------------------------
// ContextMenuCheckboxItem
// ---------------------------------------------------------------------------

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
));
ContextMenuCheckboxItem.displayName =
  ContextMenuPrimitive.CheckboxItem.displayName;

// ---------------------------------------------------------------------------
// ContextMenuRadioItem
// ---------------------------------------------------------------------------

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
));
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

// ---------------------------------------------------------------------------
// ContextMenuLabel
// ---------------------------------------------------------------------------

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold text-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

// ---------------------------------------------------------------------------
// ContextMenuSeparator
// ---------------------------------------------------------------------------

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;
(ContextMenuSeparator as any).__menuType = CONTEXT_MENU_SEPARATOR_TYPE;

// ---------------------------------------------------------------------------
// ContextMenuShortcut
// ---------------------------------------------------------------------------

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
};
ContextMenuShortcut.displayName = "ContextMenuShortcut";

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};
