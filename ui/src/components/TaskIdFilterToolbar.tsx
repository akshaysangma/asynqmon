import React, { useState, useEffect, useRef } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Button from "@material-ui/core/Button";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";

const useStyles = makeStyles((theme) => ({
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    padding: theme.spacing(1, 2),
    borderBottom: `1px solid ${theme.palette.divider}`,
    flexWrap: "wrap",
  },
  filterInput: {
    minWidth: 180,
    flex: 1,
    maxWidth: 300,
    "& .MuiInputBase-root": {
      fontSize: "0.85rem",
    },
  },
  stats: {
    fontSize: "0.8rem",
    color: theme.palette.text.secondary,
    marginLeft: theme.spacing(1),
    whiteSpace: "nowrap",
  },
  feedback: {
    fontSize: "0.8rem",
    color: theme.palette.success.main,
    marginLeft: theme.spacing(1),
  },
  searchError: {
    fontSize: "0.8rem",
    color: theme.palette.error.main,
    marginLeft: theme.spacing(1),
  },
}));

interface TaskIdFilterToolbarProps {
  filter: string;
  onFilterChange: (value: string) => void;
  totalCount: number;
  matchCount: number;
  selectedCount: number;
  onPickFiltered: () => void;
  onUnpickAll: () => void;

  // Cross-page search (absent for states that don't support it).
  searchableTotal?: number; // total tasks in the state, for the button label
  onSearchAll?: () => void;
  searching?: boolean;
  searchError?: string;
}

export default function TaskIdFilterToolbar(props: TaskIdFilterToolbarProps) {
  const {
    filter,
    onFilterChange,
    totalCount,
    matchCount,
    selectedCount,
    onPickFiltered,
    onUnpickAll,
    searchableTotal,
    onSearchAll,
    searching,
    searchError,
  } = props;
  const classes = useStyles();
  const [feedback, setFeedback] = useState("");
  const feedbackTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
      }
    };
  }, []);

  function showFeedback(msg: string) {
    setFeedback(msg);
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
    }
    feedbackTimer.current = window.setTimeout(() => {
      setFeedback("");
      feedbackTimer.current = null;
    }, 4000);
  }

  const handlePickFiltered = () => {
    onPickFiltered();
    showFeedback(`Picked ${matchCount} task(s)`);
  };

  const handleUnpickAll = () => {
    onUnpickAll();
    showFeedback("Cleared selection");
  };

  const searchReady =
    onSearchAll !== undefined && filter.trim().length >= 3 && !searching;

  return (
    <div className={classes.toolbar}>
      <TextField
        className={classes.filterInput}
        size="small"
        variant="outlined"
        placeholder="Filter by ID or payload..."
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && searchReady) {
            onSearchAll!();
          }
        }}
      />
      {onSearchAll !== undefined && filter.trim().length >= 3 && (
        <Button
          size="small"
          variant="outlined"
          color="primary"
          onClick={onSearchAll}
          disabled={searching}
        >
          Search all {(searchableTotal || 0).toLocaleString()}
        </Button>
      )}
      <Button
        size="small"
        variant="outlined"
        color="primary"
        onClick={handlePickFiltered}
        disabled={matchCount === 0}
      >
        Pick filtered
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={handleUnpickAll}
        disabled={selectedCount === 0}
      >
        Unpick all
      </Button>
      <Typography className={classes.stats} component="span">
        {matchCount}/{totalCount} match &middot; {selectedCount} selected
      </Typography>
      {feedback && (
        <Typography className={classes.feedback} component="span">
          {feedback}
        </Typography>
      )}
      {searching && (
        <Typography className={classes.stats} component="span">
          searching…
        </Typography>
      )}
      {searchError && (
        <Typography className={classes.searchError} component="span">
          {searchError}
        </Typography>
      )}
    </div>
  );
}
