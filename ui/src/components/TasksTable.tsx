import React, { useState, useCallback, useMemo } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableContainer from "@material-ui/core/TableContainer";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import TableFooter from "@material-ui/core/TableFooter";
import Paper from "@material-ui/core/Paper";
import Button from "@material-ui/core/Button";
import Checkbox from "@material-ui/core/Checkbox";
import IconButton from "@material-ui/core/IconButton";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";
import PlayArrowIcon from "@material-ui/icons/PlayArrow";
import DeleteIcon from "@material-ui/icons/Delete";
import ArchiveIcon from "@material-ui/icons/Archive";
import CancelIcon from "@material-ui/icons/Cancel";
import Alert from "@material-ui/lab/Alert";
import AlertTitle from "@material-ui/lab/AlertTitle";
import TablePaginationActions from "./TablePaginationActions";
import TableActions from "./TableActions";
import TaskIdFilterToolbar from "./TaskIdFilterToolbar";
import { usePolling } from "../hooks";
import { TaskInfoExtended } from "../reducers/tasksReducer";
import { TableColumn } from "../types/table";
import { PaginationOptions, searchTasks } from "../api";
import { TaskState } from "../types/taskState";

const useStyles = makeStyles((theme) => ({
  table: {
    width: "100%",
    tableLayout: "auto",
  },
  stickyHeaderCell: {
    background: theme.palette.background.paper,
  },
  alert: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  pagination: {
    border: "none",
  },
  paginationInner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "16px",
  },
  rowsPerPage: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
}));

interface Props {
  queue: string; // name of the queue.
  totalTaskCount: number; // totoal number of tasks in the given state.
  taskState: TaskState;
  loading: boolean;
  error: string;
  tasks: TaskInfoExtended[];
  batchActionPending: boolean;
  allActionPending: boolean;
  pollInterval: number;
  pageSize: number;
  columns: TableColumn[];

  // actions
  listTasks: (qname: string, pgn: PaginationOptions) => void;
  batchDeleteTasks?: (qname: string, taskIds: string[]) => Promise<void>;
  batchRunTasks?: (qname: string, taskIds: string[]) => Promise<void>;
  batchArchiveTasks?: (qname: string, taskIds: string[]) => Promise<void>;
  batchCancelTasks?: (qname: string, taskIds: string[]) => Promise<void>;
  deleteAllTasks?: (qname: string) => Promise<void>;
  runAllTasks?: (qname: string) => Promise<void>;
  archiveAllTasks?: (qname: string) => Promise<void>;
  cancelAllTasks?: (qname: string) => Promise<void>;
  deleteTask?: (qname: string, taskId: string) => Promise<void>;
  runTask?: (qname: string, taskId: string) => Promise<void>;
  archiveTask?: (qname: string, taskId: string) => Promise<void>;
  cancelTask?: (qname: string, taskId: string) => Promise<void>;
  taskRowsPerPageChange: (n: number) => void;

  renderRow: (rowProps: RowProps) => JSX.Element;
}

// Snapshot of an in-progress cross-page search; null when the live table is shown.
interface SearchResults {
  query: string;
  matches: TaskInfoExtended[];
  scanned: number; // cumulative tasks examined across [Search deeper] hops
  total: number;
  nextOffset: number | null;
  hint?: string;
}

export default function TasksTable(props: Props) {
  const { pollInterval, listTasks, queue, pageSize } = props;
  const classes = useStyles();
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string>("");
  const [filterText, setFilterText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(
    null
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  const filteredTasks = useMemo(() => {
    const q = filterText.toLowerCase().trim();
    if (!q) return props.tasks;
    return props.tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        (t.payload && t.payload.toLowerCase().includes(q))
    );
  }, [props.tasks, filterText]);

  // Search only wires into the plain per-state tables; the aggregating table
  // has its own group-scoped container.
  const searchSupported = props.taskState !== "aggregating";
  const inSearchMode = searchResults !== null;

  const runSearch = (offset: number, existing: SearchResults | null) => {
    const query = existing ? existing.query : filterText.trim();
    if (query.length < 3) return;
    setSearchLoading(true);
    setSearchError("");
    searchTasks(queue, props.taskState, query, offset)
      .then((resp) => {
        const newMatches = resp.matches.map((task) => ({
          ...task,
          requestPending: false,
        }));
        setSearchResults({
          query,
          matches: existing ? [...existing.matches, ...newMatches] : newMatches,
          scanned: (existing ? existing.scanned : 0) + resp.scanned,
          total: resp.total,
          nextOffset: resp.next_offset,
          hint: resp.hint,
        });
      })
      .catch((error) => {
        setSearchError(
          error?.response?.data || error?.message || "search failed"
        );
      })
      .finally(() => {
        setSearchLoading(false);
      });
  };

  const clearSearch = () => {
    setSearchResults(null);
    setSearchError("");
    setFilterText("");
  };

  const handlePageChange = (
    event: React.MouseEvent<HTMLButtonElement> | null,
    newPage: number
  ) => {
    setPage(newPage);
  };

  const handleRowsPerPageChange = (value: number) => {
    const clamped = Math.max(1, Math.min(500, value));
    props.taskRowsPerPageChange(clamped);
    setPage(0);
  };

  const displayedTasks = searchResults ? searchResults.matches : filteredTasks;

  const handleSelectAllClick = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      const newSelected = displayedTasks.map((t) => t.id);
      setSelectedIds(newSelected);
    } else {
      setSelectedIds([]);
    }
  };

  function createAllActionHandler(action: (qname: string) => Promise<void>) {
    return () => action(queue);
  }

  function createBatchActionHandler(
    action: (qname: string, taskIds: string[]) => Promise<void>
  ) {
    return () => action(queue, selectedIds).then(() => setSelectedIds([]));
  }

  function createSingleActionHandler(
    action: (qname: string, taskId: string) => Promise<void>,
    taskId: string
  ) {
    return () => action(queue, taskId);
  }

  let allActions = [];
  if (props.deleteAllTasks) {
    allActions.push({
      label: "Delete All",
      onClick: createAllActionHandler(props.deleteAllTasks),
      disabled: props.allActionPending,
    });
  }
  if (props.archiveAllTasks) {
    allActions.push({
      label: "Archive All",
      onClick: createAllActionHandler(props.archiveAllTasks),
      disabled: props.allActionPending,
    });
  }
  if (props.runAllTasks) {
    allActions.push({
      label: "Run All",
      onClick: createAllActionHandler(props.runAllTasks),
      disabled: props.allActionPending,
    });
  }
  if (props.cancelAllTasks) {
    allActions.push({
      label: "Cancel All",
      onClick: createAllActionHandler(props.cancelAllTasks),
      disabled: props.allActionPending,
    });
  }

  let batchActions = [];
  if (props.batchDeleteTasks) {
    batchActions.push({
      tooltip: "Delete",
      icon: <DeleteIcon />,
      disabled: props.batchActionPending,
      onClick: createBatchActionHandler(props.batchDeleteTasks),
    });
  }
  if (props.batchArchiveTasks) {
    batchActions.push({
      tooltip: "Archive",
      icon: <ArchiveIcon />,
      disabled: props.batchActionPending,
      onClick: createBatchActionHandler(props.batchArchiveTasks),
    });
  }
  if (props.batchRunTasks) {
    batchActions.push({
      tooltip: "Run",
      icon: <PlayArrowIcon />,
      disabled: props.batchActionPending,
      onClick: createBatchActionHandler(props.batchRunTasks),
    });
  }
  if (props.batchCancelTasks) {
    batchActions.push({
      tooltip: "Cancel",
      icon: <CancelIcon />,
      disabled: props.batchActionPending,
      onClick: createBatchActionHandler(props.batchCancelTasks),
    });
  }

  const fetchData = useCallback(() => {
    // Suspend polling while showing search results (they are a snapshot).
    if (inSearchMode) return;
    const pageOpts = { page: page + 1, size: pageSize };
    listTasks(queue, pageOpts);
  }, [page, pageSize, queue, listTasks, inSearchMode]);

  usePolling(fetchData, pollInterval);

  if (props.error.length > 0) {
    return (
      <Alert severity="error" className={classes.alert}>
        <AlertTitle>Error</AlertTitle>
        {props.error}
      </Alert>
    );
  }
  if (props.tasks.length === 0) {
    return (
      <Alert severity="info" className={classes.alert}>
        <AlertTitle>Info</AlertTitle>
        {props.taskState === "aggregating" ? (
          <div>Selected group is empty.</div>
        ) : (
          <div>No {props.taskState} tasks at this time.</div>
        )}
      </Alert>
    );
  }

  const rowCount = displayedTasks.length;
  const numSelected = selectedIds.length;
  return (
    <div>
      {!window.READ_ONLY && (
        <TableActions
          showIconButtons={numSelected > 0}
          iconButtonActions={batchActions}
          menuItemActions={allActions}
        />
      )}
      <TaskIdFilterToolbar
        filter={filterText}
        onFilterChange={setFilterText}
        totalCount={props.tasks.length}
        matchCount={filteredTasks.length}
        selectedCount={selectedIds.length}
        onPickFiltered={() => {
          const matchingIds = displayedTasks.map((t) => t.id);
          setSelectedIds(Array.from(new Set([...selectedIds, ...matchingIds])));
        }}
        onUnpickAll={() => setSelectedIds([])}
        searchableTotal={searchSupported ? props.totalTaskCount : undefined}
        onSearchAll={searchSupported ? () => runSearch(0, null) : undefined}
        searching={searchLoading}
        searchError={searchError}
      />
      <TableContainer component={Paper}>
        <Table
          stickyHeader={true}
          className={classes.table}
          aria-label={`${props.taskState} tasks table`}
          size="small"
        >
          <TableHead>
            <TableRow>
              {!window.READ_ONLY && (
                <TableCell
                  padding="checkbox"
                  classes={{ stickyHeader: classes.stickyHeaderCell }}
                >
                  <IconButton>
                    <Checkbox
                      indeterminate={numSelected > 0 && numSelected < rowCount}
                      checked={rowCount > 0 && numSelected === rowCount}
                      onChange={handleSelectAllClick}
                      inputProps={{
                        "aria-label": "select all tasks shown in the table",
                      }}
                    />
                  </IconButton>
                </TableCell>
              )}
              {props.columns
                .filter((col) => {
                  // Filter out actions column in readonly mode.
                  return !window.READ_ONLY || col.key !== "actions";
                })
                .map((col) => (
                  <TableCell
                    key={col.label}
                    align={col.align}
                    classes={{ stickyHeader: classes.stickyHeaderCell }}
                  >
                    {col.label}
                  </TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayedTasks.map((task) => {
              return props.renderRow({
                key: task.id,
                task: task,
                allActionPending: props.allActionPending,
                isSelected: selectedIds.includes(task.id),
                onSelectChange: (checked: boolean) => {
                  if (checked) {
                    setSelectedIds(selectedIds.concat(task.id));
                  } else {
                    setSelectedIds(selectedIds.filter((id) => id !== task.id));
                  }
                },
                onRunClick: props.runTask
                  ? createSingleActionHandler(props.runTask, task.id)
                  : undefined,
                onDeleteClick: props.deleteTask
                  ? createSingleActionHandler(props.deleteTask, task.id)
                  : undefined,
                onArchiveClick: props.archiveTask
                  ? createSingleActionHandler(props.archiveTask, task.id)
                  : undefined,
                onCancelClick: props.cancelTask
                  ? createSingleActionHandler(props.cancelTask, task.id)
                  : undefined,
                onActionCellEnter: () => setActiveTaskId(task.id),
                onActionCellLeave: () => setActiveTaskId(""),
                showActions: activeTaskId === task.id,
              });
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell
                colSpan={props.columns.length + 1}
                className={classes.pagination}
              >
                {searchResults ? (
                  <div className={classes.paginationInner}>
                    <Typography variant="body2" component="span" color="textSecondary">
                      {searchResults.hint
                        ? `${searchResults.matches.length} ${
                            searchResults.matches.length === 1
                              ? "match"
                              : "matches"
                          } — ${searchResults.hint}`
                        : `${searchResults.matches.length} ${
                            searchResults.matches.length === 1
                              ? "match"
                              : "matches"
                          } in first ${searchResults.scanned.toLocaleString()} of ${searchResults.total.toLocaleString()}`}
                    </Typography>
                    {searchResults.nextOffset !== null && (
                      <Button
                        size="small"
                        variant="outlined"
                        color="primary"
                        disabled={searchLoading}
                        onClick={() => runSearch(searchResults.nextOffset!, searchResults)}
                      >
                        Search deeper
                      </Button>
                    )}
                    <Button size="small" variant="outlined" onClick={clearSearch}>
                      Clear
                    </Button>
                  </div>
                ) : (
                  <div className={classes.paginationInner}>
                    <div className={classes.rowsPerPage}>
                      <Typography variant="body2" component="span">
                        Rows per page:
                      </Typography>
                      <TextField
                        type="number"
                        size="small"
                        variant="outlined"
                        value={pageSize}
                        onChange={(e) => handleRowsPerPageChange(parseInt(e.target.value, 10) || 1)}
                        inputProps={{ min: 1, max: 500, style: { width: 50, padding: "4px 8px", textAlign: "center" } }}
                      />
                      <Typography variant="body2" component="span" color="textSecondary">
                        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, props.totalTaskCount)} of {props.totalTaskCount}
                      </Typography>
                    </div>
                    <TablePaginationActions
                      count={props.totalTaskCount}
                      page={page}
                      rowsPerPage={pageSize}
                      onPageChange={handlePageChange}
                    />
                  </div>
                )}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </TableContainer>
    </div>
  );
}

export const useRowStyles = makeStyles((theme) => ({
  root: {
    cursor: "pointer",
    "& #copy-button": {
      display: "none",
    },
    "&:hover": {
      boxShadow: theme.shadows[2],
      "& #copy-button": {
        display: "inline-block",
      },
    },
    "&:hover $copyButton": {
      display: "inline-block",
    },
    "&:hover .MuiTableCell-root": {
      borderBottomColor: theme.palette.background.paper,
    },
  },
  actionCell: {
    width: "140px",
  },
  actionButton: {
    marginLeft: 3,
    marginRight: 3,
  },
  idCell: {
    width: "200px",
  },
  copyButton: {
    display: "none",
  },
  IdGroup: {
    display: "flex",
    alignItems: "center",
  },
}));

export interface RowProps {
  key: string;
  task: TaskInfoExtended;
  isSelected: boolean;
  onSelectChange: (checked: boolean) => void;
  onRunClick?: () => void;
  onDeleteClick?: () => void;
  onArchiveClick?: () => void;
  onCancelClick?: () => void;
  allActionPending: boolean;
  showActions: boolean;
  onActionCellEnter: () => void;
  onActionCellLeave: () => void;
}
