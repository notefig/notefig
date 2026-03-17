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
          // Base styles
          "group relative flex cursor-pointer items-center overflow-visible",
          "text-sm font-medium leading-tight",
          "border-b-2 transition-all duration-150",
          // Selected vs unselected
          selected
            ? "border-foreground text-foreground"
            : "border-transparent text-muted-foreground opacity-60 hover:text-foreground hover:opacity-100",
        )}
        onPointerDown={onClick}
        onDoubleClick={(e) => {
          console.log("double click", e);
        }}
        title={name}
      >
        <div className="flex min-w-0 flex-shrink items-center overflow-hidden">
          <span className="min-w-0 flex-1 truncate whitespace-nowrap py-2 pl-4 pr-1">
            {name}
          </span>
          {onClose && (
            <button
              type="button"
              className={cn(
                "mr-1 flex-shrink-0 rounded-sm p-0.5",
                "text-current opacity-0 transition-opacity",
                "hover:bg-muted-foreground/20",
                "group-hover:opacity-100",
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
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
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
