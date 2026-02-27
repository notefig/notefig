import SortableItem from "../dndkit/SortableItem";
import { cn } from "@/lib/utils";

function Tab({
  name,
  selected = true,
  onClick,
  id,
  parentId,
  address,
}: {
  name: string;
  selected?: boolean;
  onClick?: () => void;
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
          "relative flex cursor-pointer items-center overflow-visible",
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
        <div className="flex min-w-0 flex-shrink overflow-hidden">
          <span className="min-w-0 flex-1 truncate whitespace-nowrap px-4 py-2">
            {name}
          </span>
        </div>
      </div>
    </SortableItem>
  );
}

export default Tab;
