import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";
import { SunIcon, MoonIcon, SunMoonIcon } from "lucide-react";
import { useEffect, useState } from "react";
export function ThemeSwitch() {
  const { systemTheme, theme, setTheme } = useTheme();
  const currentTheme = theme === "system" ? systemTheme : theme;
  const [mounted, setMounted] = useState(false); // State to track component mount status

  useEffect(() => {
    setMounted(true); // Set mounted to true after first render (client-side)
  }, []);

  return (
    <Button
      variant="secondary"
      className="rounded-lg py-6 px-4"
      size="lg"
      onClick={() => (theme == "dark" ? setTheme("light") : setTheme("dark"))}
    >
      {mounted ? (
        currentTheme === "system" ? (
          <SunMoonIcon size="16" />
        ) : currentTheme === "light" ? (
          <SunIcon size="16" />
        ) : (
          <MoonIcon size="16" />
        )
      ) : (
        ""
      )}
    </Button>
  );
}
