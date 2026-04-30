import React, { forwardRef, memo, type ReactNode } from "react";

export interface TableColumn<TData, TValue = unknown> {
  key: keyof TData & string;
  title: ReactNode;
  render?: (value: TValue, row: TData, index: number) => ReactNode;
}

export type AsyncState<TData, TError extends Error = Error> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: TData }
  | { status: "error"; error: TError };

export type DataTableProps<TData extends { id: string }, TMeta = Record<string, never>> = {
  rows: readonly TData[];
  columns: readonly TableColumn<TData>[];
  meta?: TMeta;
  children?: (row: TData) => ReactNode;
  onSelect?: <TKey extends keyof TData>(row: TData, key: TKey, value: TData[TKey]) => void;
};

export function DataTable<TData extends { id: string }, TMeta = Record<string, never>>(
  props: DataTableProps<TData, TMeta>,
) {
  return (
    <section data-count={props.rows.length}>
      {props.rows.map((row, index) => (
        <article key={row.id}>
          {props.columns.map((column) => (
            <button key={column.key} onClick={() => props.onSelect?.(row, column.key, row[column.key])}>
              {column.title}
              {column.render?.(row[column.key], row, index)}
            </button>
          ))}
          {props.children?.(row)}
        </article>
      ))}
    </section>
  );
}

export function ToolbarInner(props: { label: string; actions?: readonly string[] }, ref: React.Ref<HTMLDivElement>) {
  return (
    <div ref={ref} aria-label={props.label}>
      {props.actions?.map((action) => <button key={action}>{action}</button>)}
    </div>
  );
}

export const Toolbar = memo(forwardRef(ToolbarInner));

export function withAsyncState<TProps extends object, TData>(
  Component: React.ComponentType<TProps & { state: AsyncState<TData> }>,
) {
  return function WithAsyncState(props: TProps & { state: AsyncState<TData> }) {
    if (props.state.status === "loading") {
      return <span>Loading</span>;
    }
    return <Component {...props} />;
  };
}

export function selectValue<TData, TKey extends keyof TData>(row: TData, key: TKey): TData[TKey];
export function selectValue<TData, TKey extends keyof TData>(
  row: TData,
  key: TKey,
  fallback: NonNullable<TData[TKey]>,
): NonNullable<TData[TKey]>;
export function selectValue<TData, TKey extends keyof TData>(
  row: TData,
  key: TKey,
  fallback?: NonNullable<TData[TKey]>,
) {
  return row[key] ?? fallback;
}

export default memo(DataTable) as typeof DataTable;
