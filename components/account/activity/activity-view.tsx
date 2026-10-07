"use client";

import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { DataTable } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import { Icon } from "@/components/icons/icon";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_COPY,
  ACTIVITY_KIND_OPTIONS,
  ACTIVITY_LIST,
  activityDate,
  activityDateTime,
  activityExportPath,
  activityExportToast,
  activityQueryFromState,
  activityRangeLabel,
  activityVisual,
  rowCountFrom,
  type ActivityEvent,
  type ActivityTone,
} from "./activity-model";
import { downloadFromApi } from "./download-file";

const TILE: Record<ActivityTone, string> = {
  lavender: "bg-lavender-bg text-lavender-fg",
  blue: "bg-blue-bg text-blue-fg",
  sage: "bg-sage-bg text-sage-fg",
  peach: "bg-peach-bg text-peach-fg",
  pink: "bg-pink-bg text-pink-fg",
};

function KindTile({ kind }: { kind: string }) {
  const visual = activityVisual(kind);
  return (
    <span aria-hidden="true" className={cn("grid size-6 shrink-0 place-items-center rounded-[7px]", TILE[visual.tone])}>
      <Icon name={visual.icon} size={15} />
    </span>
  );
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={activityDateTime(at)} className="whitespace-nowrap">
      {activityDate(at)}
    </time>
  );
}

/** WHEN | WHO | ACTION (kind tile + action) | ITEM, as in the prototype (no sortable columns; newest first). */
const COLUMNS: ColumnDef<ActivityEvent>[] = [
  {
    id: "when",
    header: ACTIVITY_COPY.columns.when,
    enableSorting: false,
    cell: ({ row }) => <When at={row.original.at} />,
    meta: { className: "whitespace-nowrap font-semibold text-ink-2" },
  },
  {
    id: "who",
    header: ACTIVITY_COPY.columns.who,
    enableSorting: false,
    cell: ({ row }) => row.original.actorName,
    meta: { className: "font-bold" },
  },
  {
    id: "action",
    header: ACTIVITY_COPY.columns.action,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2 font-semibold">
        <KindTile kind={row.original.kind} />
        {row.original.action}
      </span>
    ),
    meta: { rowHeader: true },
  },
  {
    id: "item",
    header: ACTIVITY_COPY.columns.item,
    enableSorting: false,
    cell: ({ row }) => row.original.target,
    meta: { className: "break-words font-semibold text-ink-2" },
  },
];

/** Card below 760px: kind tile, action, item, then "who · date". */
function activityCard(event: ActivityEvent): React.ReactNode {
  return (
    <div className="flex items-start gap-2.5 text-[13.5px]">
      <KindTile kind={event.kind} />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-bold text-ink">{event.action}</p>
        {event.target ? <p className="m-0 mt-0.5 break-words font-semibold text-ink-2">{event.target}</p> : null}
        <p className="m-0 mt-1 text-[12.5px] font-semibold text-ink-2">
          {event.actorName} <span aria-hidden="true">·</span> <When at={event.at} />
        </p>
      </div>
    </div>
  );
}

export type ActivityViewProps = {
  /** The page the server rendered for the URL's ?kind=&q=&page=. */
  data: { events: ActivityEvent[]; total: number; pageSize: number };
};

/**
 * "Activity log" (Owner only; the page checks `activity.view`): header with "Export CSV" (all rows matching the
 * filters, from the server), then the table with search, Type filter and Previous / Next, 10 per page. Search,
 * filter and page live in the URL and the server renders each page.
 */
export function ActivityView({ data }: ActivityViewProps) {
  const list = useListState(ACTIVITY_LIST);
  const [exporting, setExporting] = React.useState(false);
  const query = activityQueryFromState(list.applied);

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const { fileName, headers } = await downloadFromApi(activityExportPath(query), ACTIVITY_COPY.fileName);
      const rows = rowCountFrom(headers.get("x-row-count"));
      toast.success(rows === null ? `Exported ${fileName}` : activityExportToast(rows, fileName, headers.get("x-truncated") === "1"));
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={ACTIVITY_COPY.title}
        description={ACTIVITY_COPY.description}
        actions={
          <PageAction icon="download" onClick={exportCsv} busy={exporting}>
            {ACTIVITY_COPY.exportCsv}
          </PageAction>
        }
      />
      <DataTable
        columns={COLUMNS}
        data={data.events}
        getRowId={(event) => event.id}
        getRowLabel={(event) => `${event.action} ${event.target}`.trim()}
        caption={ACTIVITY_COPY.caption}
        toolbar={{
          search: {
            value: list.state.q,
            onChange: list.setQuery,
            placeholder: ACTIVITY_COPY.searchPlaceholder,
            label: ACTIVITY_COPY.searchLabel,
          },
          filters: [
            {
              id: "kind",
              label: ACTIVITY_COPY.type,
              options: ACTIVITY_KIND_OPTIONS,
              value: list.state.filters.kind,
              onChange: (value) => list.setFilter("kind", value),
            },
          ],
          onClear: list.clear,
        }}
        pagination={{
          page: list.applied.page,
          pageSize: data.pageSize,
          total: data.total,
          onPageChange: list.setPage,
          pageHref: list.pageHref,
          label: ACTIVITY_COPY.pagination,
          emptyLabel: ACTIVITY_COPY.emptyFooter,
          rangeLabel: activityRangeLabel,
        }}
        emptyState={list.isFiltered ? ACTIVITY_COPY.empty : ACTIVITY_COPY.emptyAll}
        mobileCard={activityCard}
        loading={list.isPending}
        minWidth={680}
      />
    </>
  );
}
