import type { HTMLAttributes, ReactNode } from "react"

interface AnimatedSectionProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  delay?: number
}

export function AnimatedSection({ children, className, delay, ...props }: AnimatedSectionProps) {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  )
}
