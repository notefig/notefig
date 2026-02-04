import { useMemo, useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface Tab {
  id: string;
  name: string;
  isModified?: boolean;
}

interface TabBarProps {
  onNewTab: () => void;
}

interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  showDropIndicator?: "left" | "right" | null;
}

function SortableTab({
  tab,
  isActive,
  onSelect,
  onClose,
  showDropIndicator = null,
}: SortableTabProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  if (isDragging) {
    return (
      <div ref={setNodeRef} style={style} className="h-9 w-32 opacity-0" />
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "group flex items-center gap-2 h-9 px-3 transition-colors relative cursor-pointer",
        "border-e rtl:border-e-0 rtl:border-s border-border",
        isActive
          ? "bg-background text-foreground"
          : "bg-secondary/30 text-muted-foreground hover:bg-secondary/60",
      )}
      onClick={() => onSelect(tab.id)}
    >
      {showDropIndicator && (
        <div
          className={cn(
            "absolute top-0 bottom-0 w-1 bg-primary z-10",
            showDropIndicator === "left" ? "left-0" : "right-0",
          )}
        />
      )}

      <span className="text-sm truncate max-w-32">{tab.name}</span>
      {tab.isModified && <span className="w-2 h-2 rounded-full bg-primary" />}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="p-0.5 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="w-3.5 h-3.5" />
        <span className="sr-only">{t("closeTab")}</span>
      </button>
    </div>
  );
}

export function TabBar({ onNewTab }: TabBarProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overId, setOverId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const tabs = useMemo<Tab[]>(() => {
    const tabIds = searchParams.getAll("tab");
    return tabIds.map((id) => ({
      id,
      name: id.split("/").pop() || id,
      isModified: false, // TODO: Track modifications
    }));
  }, [searchParams]);

  const activeTabId = searchParams.get("activeTab");

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleTabSelect = useCallback(
    (tabId: string) => {
      setSearchParams((prev) => {
        const newParams = new URLSearchParams(prev);
        newParams.set("activeTab", tabId);
        return newParams;
      });
    },
    [setSearchParams],
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      setSearchParams((prev) => {
        const currentTabs = prev.getAll("tab");
        const newTabs = currentTabs.filter((id) => id !== tabId);
        const isActiveTab = prev.get("activeTab") === tabId;

        const newParams = new URLSearchParams();

        prev.forEach((value, key) => {
          if (key !== "tab" && key !== "activeTab") {
            newParams.append(key, value);
          }
        });

        newTabs.forEach((tab) => newParams.append("tab", tab));

        if (isActiveTab && newTabs.length > 0) {
          newParams.set("activeTab", newTabs[newTabs.length - 1]);
        } else if (!isActiveTab && prev.get("activeTab")) {
          newParams.set("activeTab", prev.get("activeTab")!);
        }

        return newParams;
      });
    },
    [setSearchParams],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (over && active.id !== over.id) {
        const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
        const newIndex = tabs.findIndex((tab) => tab.id === over.id);
        const reorderedTabs = arrayMove(tabs, oldIndex, newIndex);

        setSearchParams((prev) => {
          const newParams = new URLSearchParams();

          prev.forEach((value, key) => {
            if (key !== "tab" && key !== "activeTab") {
              newParams.append(key, value);
            }
          });

          reorderedTabs.forEach((tab) => newParams.append("tab", tab.id));

          const activeTab = prev.get("activeTab");
          if (activeTab) {
            newParams.set("activeTab", activeTab);
          }

          return newParams;
        });
      }

      setActiveId(null);
      setOverId(null);
    },
    [tabs, setSearchParams],
  );

  const getDropIndicator = useCallback(
    (tabId: string): "left" | "right" | null => {
      if (!activeId || !overId || overId !== tabId) return null;

      const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
      const overIndex = tabs.findIndex((tab) => tab.id === overId);

      return activeIndex < overIndex ? "right" : "left";
    },
    [activeId, overId, tabs],
  );

  return (
    <div className="flex items-center h-9 bg-secondary/50 border-b border-border">
      <ScrollArea className="flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveId(e.active.id as string)}
          onDragOver={(e: DragOverEvent) =>
            setOverId(e.over?.id as string | null)
          }
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setActiveId(null);
            setOverId(null);
          }}
          modifiers={[restrictToHorizontalAxis]}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center">
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={activeTabId === tab.id}
                  onSelect={handleTabSelect}
                  onClose={handleTabClose}
                  showDropIndicator={getDropIndicator(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>
      <button
        onClick={onNewTab}
        className="flex items-center justify-center w-9 h-9 hover:bg-accent transition-colors shrink-0 border-s rtl:border-s-0 rtl:border-e border-border"
      >
        <Plus className="w-4 h-4 text-muted-foreground" />
        <span className="sr-only">{t("newTab")}</span>
      </button>
    </div>
  );
}
