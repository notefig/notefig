import { Icons } from "@/components/icons";

export function TopNav() {
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span>documentation</span>
          <Icons.chevronRight className="h-4 w-4" />
          <span className="text-foreground">introduction.md</span>
        </div>
        <div className="ml-2 hidden items-center gap-2 text-xs text-muted-foreground md:flex">
          <span className="flex h-1.5 w-1.5 rounded-full bg-green-500" />
          Saved
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-muted">
          <Icons.cloud className="h-4 w-4" />
          <span className="hidden sm:inline">Sync</span>
        </button>
        <button className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-muted">
          <Icons.save className="h-4 w-4" />
          <span className="hidden sm:inline">Save</span>
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          <Icons.share className="h-4 w-4" />
          <span>Publish</span>
        </button>
      </div>
    </header>
  );
}
