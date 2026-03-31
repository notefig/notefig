import SortableItem from "../dndkit/SortableItem";
import { cn } from "@/lib/utils";

function Tab({
  name,
  selected = true,
  onClick,
  onClose,
  id,
  parentId,
  address,
}: {
  name: string;
  selected?: boolean;
  onClick?: () => void;
  onClose?: () => void;
  id: string;
  parentId: string;
  address: number[];
}) {
  return (
    <SortableItem
      key={id}
      id={id}
      data={{
        type: "tab",
        parentId,
        address,
      }}
      style={{
        display: "flex",
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <div
        className={cn(
          // Base styles - smooth blended appearance
          "group relative flex cursor-pointer items-center overflow-visible",
          "text-sm font-medium leading-tight",
          "transition-all duration-300 ease-out",
          "rounded-t-xl",
          "mt-2 mx-0.5",
          // Selected vs unselected - soft shadow-based style
          selected
            ? "bg-background/95 text-foreground z-10"
            : "bg-transparent text-muted-foreground/80 hover:text-foreground",
        )}
        style={{
          boxShadow: selected
            ? "0 -4px 20px -4px rgba(0,0,0,0.12), 0 -2px 8px -2px rgba(0,0,0,0.08), inset 0 1px 0 0 rgba(255,255,255,0.8)"
            : "inset 0 -1px 0 0 rgba(0,0,0,0.05)",
        }}
        onPointerDown={onClick}
        onDoubleClick={(e) => {
          console.log("double click", e);
        }}
        title={name}
      >
        <div className="flex min-w-0 flex-shrink items-center overflow-hidden">
          <span
            className={cn(
              "min-w-0 flex-1 truncate whitespace-nowrap px-4 py-2.5",
            )}
          >
            {name}
          </span>
          {onClose && (
            <button
              type="button"
              className={cn(
                "mr-2 flex-shrink-0 rounded-full p-1",
                "text-current opacity-0 transition-all duration-200",
                "hover:bg-muted-foreground/10 hover:shadow-sm",
                "group-hover:opacity-70",
                selected && "opacity-50 group-hover:opacity-100",
              )}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label="Close tab"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </SortableItem>
  );
}

export default Tab;
