type WithChildren = { children?: React.ReactNode };

interface ConditionallyWrapProps<T extends WithChildren> {
  condition: boolean;
  wrapper: React.ComponentType<T>;
  wrapperProps: Omit<T, "children">;
  children: React.ReactNode;
}

export function ConditionallyWrap<T extends WithChildren>({
  condition,
  wrapper: Wrapper,
  wrapperProps,
  children,
}: ConditionallyWrapProps<T>) {
  if (condition) {
    return <Wrapper {...(wrapperProps as T)}>{children}</Wrapper>;
  }
  return <>{children}</>;
}
