import { useDroppable } from "@dnd-kit/core";

type DroppableProps = {
  id: string;
  style?: React.CSSProperties;
  overStyle?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  ref?: (element: HTMLDivElement | null) => void;
} & React.HTMLAttributes<HTMLDivElement>;
function Droppable({
  id,
  style,
  overStyle,
  className,
  children,
  data,
  ref: externalRef,
  ...rest
}: DroppableProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: data,
  });

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        externalRef?.(element);
      }}
      {...rest}
      style={{
        ...style,
        ...(isOver && overStyle),
      }}
      className={className}
    >
      {children}
    </div>
  );
}

export default Droppable;
