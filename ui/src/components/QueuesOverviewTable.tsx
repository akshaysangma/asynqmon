import React, { useState } from "react";
import clsx from "clsx";
import { connect, ConnectedProps } from "react-redux";
import { Link } from "react-router-dom";
import { makeStyles } from "@material-ui/core/styles";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableContainer from "@material-ui/core/TableContainer";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import TableSortLabel from "@material-ui/core/TableSortLabel";
import Checkbox from "@material-ui/core/Checkbox";
import IconButton from "@material-ui/core/IconButton";
import ListItemText from "@material-ui/core/ListItemText";
import Menu from "@material-ui/core/Menu";
import MenuItem from "@material-ui/core/MenuItem";
import Tooltip from "@material-ui/core/Tooltip";
import PauseCircleFilledIcon from "@material-ui/icons/PauseCircleFilled";
import PlayCircleFilledIcon from "@material-ui/icons/PlayCircleFilled";
import DeleteIcon from "@material-ui/icons/Delete";
import MoreHorizIcon from "@material-ui/icons/MoreHoriz";
import ViewColumnIcon from "@material-ui/icons/ViewColumn";
import DeleteQueueConfirmationDialog from "./DeleteQueueConfirmationDialog";
import { Queue } from "../api";
import { queueDetailsPath } from "../paths";
import { AppState } from "../store";
import { dashboardHiddenColumnsChange } from "../actions/settingsActions";
import { SortDirection, SortableTableColumn } from "../types/table";
import { TaskState } from "../types/taskState";
import prettyBytes from "pretty-bytes";
import { percentage } from "../utils";

const useStyles = makeStyles((theme) => ({
  table: {
    minWidth: 650,
  },
  fixedCell: {
    position: "sticky",
    zIndex: 1,
    left: 0,
    background: theme.palette.background.paper,
  },
  fixedRightCell: {
    position: "sticky",
    zIndex: 1,
    right: 0,
    background: theme.palette.background.paper,
  },
  columnSelectorBar: {
    display: "flex",
    justifyContent: "flex-end",
  },
}));

interface QueueWithMetadata extends Queue {
  requestPending: boolean; // indicates pause/resume/delete request is pending for the queue.
}

function mapStateToProps(state: AppState) {
  return {
    hiddenColumns: state.settings.dashboardHiddenColumns,
  };
}

const connector = connect(mapStateToProps, { dashboardHiddenColumnsChange });

interface OwnProps {
  queues: QueueWithMetadata[];
  onPauseClick: (qname: string) => Promise<void>;
  onResumeClick: (qname: string) => Promise<void>;
  onDeleteClick: (qname: string) => Promise<void>;
}

type Props = OwnProps & ConnectedProps<typeof connector>;

enum SortBy {
  Queue,
  State,
  Size,
  Active,
  Pending,
  Aggregating,
  Scheduled,
  Retry,
  Archived,
  Completed,
  MemoryUsage,
  Latency,
  Processed,
  Failed,
  ErrorRate,

  None, // no sort support
}

interface StateColumnConfig extends SortableTableColumn<SortBy> {
  taskState: TaskState;
  getCount: (q: Queue) => number;
}

// Per-state count columns, in the same order as the queue-details tabs.
const stateColConfigs: StateColumnConfig[] = [
  { label: "Active", key: "active", sortBy: SortBy.Active, align: "right", taskState: "active", getCount: (q) => q.active },
  { label: "Pending", key: "pending", sortBy: SortBy.Pending, align: "right", taskState: "pending", getCount: (q) => q.pending },
  { label: "Aggregating", key: "aggregating", sortBy: SortBy.Aggregating, align: "right", taskState: "aggregating", getCount: (q) => q.aggregating },
  { label: "Scheduled", key: "scheduled", sortBy: SortBy.Scheduled, align: "right", taskState: "scheduled", getCount: (q) => q.scheduled },
  { label: "Retry", key: "retry", sortBy: SortBy.Retry, align: "right", taskState: "retry", getCount: (q) => q.retry },
  { label: "Archived", key: "archived", sortBy: SortBy.Archived, align: "right", taskState: "archived", getCount: (q) => q.archived },
  { label: "Completed", key: "completed", sortBy: SortBy.Completed, align: "right", taskState: "completed", getCount: (q) => q.completed },
];

const colConfigs: SortableTableColumn<SortBy>[] = [
  { label: "Queue", key: "queue", sortBy: SortBy.Queue, align: "left" },
  { label: "State", key: "state", sortBy: SortBy.State, align: "left" },
  {
    label: "Size",
    key: "size",
    sortBy: SortBy.Size,
    align: "right",
  },
  ...stateColConfigs,
  {
    label: "Memory usage",
    key: "memory_usage",
    sortBy: SortBy.MemoryUsage,
    align: "right",
  },
  {
    label: "Latency",
    key: "latency",
    sortBy: SortBy.Latency,
    align: "right",
  },
  {
    label: "Processed",
    key: "processed",
    sortBy: SortBy.Processed,
    align: "right",
  },
  { label: "Failed", key: "failed", sortBy: SortBy.Failed, align: "right" },
  {
    label: "Error rate",
    key: "error_rate",
    sortBy: SortBy.ErrorRate,
    align: "right",
  },
  { label: "Actions", key: "actions", sortBy: SortBy.None, align: "center" },
];

// Queue (identity) and Actions (controls) are always shown.
const hideableColConfigs = colConfigs.filter(
  (cfg) => cfg.key !== "queue" && cfg.key !== "actions"
);

// sortQueues takes a array of queues and return a sorted array.
// It returns a new array and leave the original array untouched.
function sortQueues(
  queues: QueueWithMetadata[],
  cmpFn: (first: QueueWithMetadata, second: QueueWithMetadata) => number
): QueueWithMetadata[] {
  let copy = [...queues];
  copy.sort(cmpFn);
  return copy;
}

function QueuesOverviewTable(props: Props) {
  const classes = useStyles();
  const [sortBy, setSortBy] = useState<SortBy>(SortBy.Queue);
  const [sortDir, setSortDir] = useState<SortDirection>(SortDirection.Asc);
  const [queueToDelete, setQueueToDelete] = useState<QueueWithMetadata | null>(
    null
  );
  const [columnMenuAnchor, setColumnMenuAnchor] = useState<HTMLElement | null>(
    null
  );
  const hiddenColumns = new Set(props.hiddenColumns);
  const toggleColumn = (key: string) => {
    props.dashboardHiddenColumnsChange(
      hiddenColumns.has(key)
        ? props.hiddenColumns.filter((k) => k !== key)
        : [...props.hiddenColumns, key]
    );
  };
  const createSortClickHandler = (sortKey: SortBy) => (e: React.MouseEvent) => {
    if (sortKey === sortBy) {
      // Toggle sort direction.
      const nextSortDir =
        sortDir === SortDirection.Asc ? SortDirection.Desc : SortDirection.Asc;
      setSortDir(nextSortDir);
    } else {
      // Change the sort key.
      setSortBy(sortKey);
    }
  };

  const cmpFunc = (q1: QueueWithMetadata, q2: QueueWithMetadata): number => {
    let isQ1Smaller: boolean;
    const stateCol = stateColConfigs.find((cfg) => cfg.sortBy === sortBy);
    if (stateCol) {
      const c1 = stateCol.getCount(q1);
      const c2 = stateCol.getCount(q2);
      if (c1 === c2) return 0;
      return (c1 < c2) === (sortDir === SortDirection.Asc) ? -1 : 1;
    }
    switch (sortBy) {
      case SortBy.Queue:
        if (q1.queue === q2.queue) return 0;
        isQ1Smaller = q1.queue < q2.queue;
        break;
      case SortBy.State:
        if (q1.paused === q2.paused) return 0;
        isQ1Smaller = !q1.paused;
        break;
      case SortBy.Size:
        if (q1.size === q2.size) return 0;
        isQ1Smaller = q1.size < q2.size;
        break;
      case SortBy.MemoryUsage:
        if (q1.memory_usage_bytes === q2.memory_usage_bytes) return 0;
        isQ1Smaller = q1.memory_usage_bytes < q2.memory_usage_bytes;
        break;
      case SortBy.Latency:
        if (q1.latency_msec === q2.latency_msec) return 0;
        isQ1Smaller = q1.latency_msec < q2.latency_msec;
        break;
      case SortBy.Processed:
        if (q1.processed === q2.processed) return 0;
        isQ1Smaller = q1.processed < q2.processed;
        break;
      case SortBy.Failed:
        if (q1.failed === q2.failed) return 0;
        isQ1Smaller = q1.failed < q2.failed;
        break;
      case SortBy.ErrorRate:
        const q1ErrorRate = q1.failed / q1.processed;
        const q2ErrorRate = q2.failed / q2.processed;
        if (q1ErrorRate === q2ErrorRate) return 0;
        isQ1Smaller = q1ErrorRate < q2ErrorRate;
        break;
      default:
        // eslint-disable-next-line no-throw-literal
        throw `Unexpected order by value: ${sortBy}`;
    }
    if (sortDir === SortDirection.Asc) {
      return isQ1Smaller ? -1 : 1;
    } else {
      return isQ1Smaller ? 1 : -1;
    }
  };

  const handleDialogClose = () => {
    setQueueToDelete(null);
  };

  return (
    <React.Fragment>
      <div className={classes.columnSelectorBar}>
        <Tooltip title="Choose columns">
          <IconButton
            size="small"
            aria-label="choose visible columns"
            onClick={(e) => setColumnMenuAnchor(e.currentTarget)}
          >
            <ViewColumnIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={columnMenuAnchor}
          open={Boolean(columnMenuAnchor)}
          onClose={() => setColumnMenuAnchor(null)}
        >
          {hideableColConfigs.map((cfg) => (
            <MenuItem key={cfg.key} dense onClick={() => toggleColumn(cfg.key)}>
              <Checkbox
                size="small"
                checked={!hiddenColumns.has(cfg.key)}
                disableRipple
              />
              <ListItemText primary={cfg.label} />
            </MenuItem>
          ))}
        </Menu>
      </div>
      <TableContainer>
        <Table className={classes.table} aria-label="queues overview table">
          <TableHead>
            <TableRow>
              {colConfigs
                .filter((cfg) => {
                  // Filter out actions column in readonly mode.
                  return !window.READ_ONLY || cfg.key !== "actions";
                })
                .filter((cfg) => !hiddenColumns.has(cfg.key))
                .map((cfg) => (
                  <TableCell
                    key={cfg.key}
                    align={cfg.align}
                    className={clsx(
                      cfg.key === "queue" && classes.fixedCell,
                      cfg.key === "actions" && classes.fixedRightCell
                    )}
                  >
                    {cfg.sortBy !== SortBy.None ? (
                      <TableSortLabel
                        active={sortBy === cfg.sortBy}
                        direction={sortDir}
                        onClick={createSortClickHandler(cfg.sortBy)}
                      >
                        {cfg.label}
                      </TableSortLabel>
                    ) : (
                      <div>{cfg.label}</div>
                    )}
                  </TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {sortQueues(props.queues, cmpFunc).map((q) => (
              <Row
                key={q.queue}
                queue={q}
                hiddenColumns={hiddenColumns}
                onPauseClick={() => props.onPauseClick(q.queue)}
                onResumeClick={() => props.onResumeClick(q.queue)}
                onDeleteClick={() => setQueueToDelete(q)}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <DeleteQueueConfirmationDialog
        onClose={handleDialogClose}
        queue={queueToDelete}
      />
    </React.Fragment>
  );
}

const useRowStyles = makeStyles((theme) => ({
  row: {
    "&:last-child td": {
      borderBottomWidth: 0,
    },
    "&:last-child th": {
      borderBottomWidth: 0,
    },
  },
  linkText: {
    textDecoration: "none",
    color: theme.palette.text.primary,
    "&:hover": {
      textDecoration: "underline",
    },
  },
  zeroCount: {
    color: theme.palette.text.disabled,
  },
  textGreen: {
    color: theme.palette.success.dark,
  },
  textRed: {
    color: theme.palette.error.dark,
  },
  boldCell: {
    fontWeight: 600,
  },
  fixedCell: {
    position: "sticky",
    zIndex: 1,
    left: 0,
    background: theme.palette.background.paper,
  },
  actionIconsContainer: {
    display: "flex",
    justifyContent: "center",
    minWidth: "100px",
  },
  fixedRightCell: {
    position: "sticky",
    zIndex: 1,
    right: 0,
    background: theme.palette.background.paper,
  },
}));

interface RowProps {
  queue: QueueWithMetadata;
  hiddenColumns: Set<string>;
  onPauseClick: () => void;
  onResumeClick: () => void;
  onDeleteClick: () => void;
}

function Row(props: RowProps) {
  const classes = useRowStyles();
  const { queue: q, hiddenColumns } = props;
  const [showIcons, setShowIcons] = useState<boolean>(false);
  const show = (key: string) => !hiddenColumns.has(key);
  return (
    <TableRow key={q.queue} className={classes.row}>
      <TableCell
        component="th"
        scope="row"
        className={clsx(classes.boldCell, classes.fixedCell)}
      >
        <Link to={queueDetailsPath(q.queue)} className={classes.linkText}>
          {q.queue}
        </Link>
      </TableCell>
      {show("state") && (
        <TableCell>
          {q.paused ? (
            <span className={classes.textRed}>paused</span>
          ) : (
            <span className={classes.textGreen}>run</span>
          )}
        </TableCell>
      )}
      {show("size") && (
        <TableCell align="right">{q.size.toLocaleString()}</TableCell>
      )}
      {stateColConfigs
        .filter((cfg) => show(cfg.key))
        .map((cfg) => {
          const count = cfg.getCount(q);
          return (
            <TableCell key={cfg.key} align="right">
              <Link
                to={queueDetailsPath(q.queue, cfg.taskState)}
                className={clsx(classes.linkText, count === 0 && classes.zeroCount)}
              >
                {count.toLocaleString()}
              </Link>
            </TableCell>
          );
        })}
      {show("memory_usage") && (
        <TableCell align="right">{prettyBytes(q.memory_usage_bytes)}</TableCell>
      )}
      {show("latency") && (
        <TableCell align="right">{q.display_latency}</TableCell>
      )}
      {show("processed") && (
        <TableCell align="right">{q.processed.toLocaleString()}</TableCell>
      )}
      {show("failed") && (
        <TableCell align="right">{q.failed.toLocaleString()}</TableCell>
      )}
      {show("error_rate") && (
        <TableCell align="right">{percentage(q.failed, q.processed)}</TableCell>
      )}
      {!window.READ_ONLY && (
        <TableCell
          align="center"
          className={classes.fixedRightCell}
          onMouseEnter={() => setShowIcons(true)}
          onMouseLeave={() => setShowIcons(false)}
        >
          <div className={classes.actionIconsContainer}>
            {showIcons ? (
              <React.Fragment>
                {q.paused ? (
                  <Tooltip title="Resume">
                    <IconButton
                      color="secondary"
                      onClick={props.onResumeClick}
                      disabled={q.requestPending}
                      size="small"
                    >
                      <PlayCircleFilledIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <Tooltip title="Pause">
                    <IconButton
                      color="primary"
                      onClick={props.onPauseClick}
                      disabled={q.requestPending}
                      size="small"
                    >
                      <PauseCircleFilledIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Delete">
                  <IconButton onClick={props.onDeleteClick} size="small">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </React.Fragment>
            ) : (
              <IconButton size="small">
                <MoreHorizIcon fontSize="small" />
              </IconButton>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

export default connector(QueuesOverviewTable);
