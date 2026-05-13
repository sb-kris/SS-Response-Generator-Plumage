"use client";

import { useTheme } from "next-themes";
import { Toaster as SonnerToaster } from "sonner";

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();
  return (
    <SonnerToaster
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          // Glass treatment — translucent background + backdrop blur so the
          // page content fogs through the toast surface. Softer border at
          // 50% to match the other glass surfaces (header, cost panel).
          toast:
            "group toast group-[.toaster]:border-border/50 group-[.toaster]:bg-background/80 group-[.toaster]:text-foreground group-[.toaster]:backdrop-blur-xl group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
