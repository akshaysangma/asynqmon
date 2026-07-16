import React from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TasksTable, { RowProps } from "./TasksTable";
import { TaskInfoExtended } from "../reducers/tasksReducer";
import { TableColumn } from "../types/table";
import { searchTasks, getTaskInfo, TaskInfo } from "../api";

jest.mock("../api");

const mockedSearchTasks = searchTasks as jest.MockedFunction<
  typeof searchTasks
>;
const mockedGetTaskInfo = getTaskInfo as jest.MockedFunction<
  typeof getTaskInfo
>;

const columns: TableColumn[] = [{ key: "id", label: "ID", align: "left" }];

function renderRow(rowProps: RowProps) {
  return (
    <tr key={rowProps.key}>
      <td>{rowProps.task.id}</td>
    </tr>
  );
}

function makeTaskInfo(id: string, state: string = "pending"): TaskInfo {
  return {
    id,
    queue: "default",
    type: "email:send",
    payload: "{}",
    state,
    start_time: "",
    max_retry: 0,
    retried: 0,
    last_failed_at: "",
    error_message: "",
    next_process_at: "",
    timeout_seconds: 0,
    deadline: "",
    group: "",
    completed_at: "",
    result: "",
    ttl_seconds: 0,
    is_orphaned: false,
  };
}

function makeTask(id: string, state: string = "pending"): TaskInfoExtended {
  return { ...makeTaskInfo(id, state), requestPending: false };
}

function renderTasksTable() {
  const localTask = makeTask("local-task-not-matching");
  return render(
    <MemoryRouter>
      <TasksTable
        queue="default"
        totalTaskCount={1}
        taskState="pending"
        loading={false}
        error=""
        tasks={[localTask]}
        batchActionPending={false}
        allActionPending={false}
        pollInterval={300}
        pageSize={20}
        columns={columns}
        listTasks={jest.fn()}
        taskRowsPerPageChange={jest.fn()}
        renderRow={renderRow}
      />
    </MemoryRouter>
  );
}

describe("TasksTable cross-page search match count", () => {
  beforeEach(() => {
    mockedSearchTasks.mockReset();
  });

  it("enables Pick filtered with the search match count when the local page has no matches", async () => {
    mockedSearchTasks.mockResolvedValue({
      matches: [makeTask("remote-match-1"), makeTask("remote-match-2")],
      scanned: 1000,
      total: 5000,
      next_offset: null,
    });

    renderTasksTable();

    // "xyz" matches neither the local task's ID nor its payload, so the
    // locally-loaded page has zero matches (today's bug state).
    userEvent.type(
      screen.getByPlaceholderText("Filter by ID or payload..."),
      "xyz"
    );

    fireEvent.click(screen.getByText(/Search all/));

    const pickFilteredButton = await screen.findByRole("button", {
      name: "Pick filtered",
    });
    await waitFor(() => expect(pickFilteredButton).toBeEnabled());

    expect(screen.getByText(/2\/1000 match/)).toBeInTheDocument();

    fireEvent.click(pickFilteredButton);

    expect(screen.getByText(/2 selected/)).toBeInTheDocument();
  });
});

describe("TasksTable exact-ID lookup", () => {
  beforeEach(() => {
    mockedGetTaskInfo.mockReset();
  });

  it("renders the single row and allows selecting it when the task is found in the current tab's state", async () => {
    mockedGetTaskInfo.mockResolvedValue(makeTaskInfo("exact-task-1", "pending"));

    renderTasksTable();

    userEvent.type(screen.getByPlaceholderText("exact ID…"), "exact-task-1{enter}");

    expect(await screen.findByText("exact-task-1")).toBeInTheDocument();
    expect(screen.queryByText("local-task-not-matching")).not.toBeInTheDocument();

    const selectAll = screen.getByRole("checkbox", {
      name: "select all tasks shown in the table",
    });
    expect(selectAll).toBeEnabled();

    fireEvent.click(selectAll);

    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });

  it("shows a link to the task's actual state and no row when found in a different state", async () => {
    mockedGetTaskInfo.mockResolvedValue(
      makeTaskInfo("exact-task-2", "completed")
    );

    renderTasksTable();

    userEvent.type(screen.getByPlaceholderText("exact ID…"), "exact-task-2{enter}");

    const link = await screen.findByRole("link", { name: "completed" });
    expect(link.getAttribute("href")).toEqual(
      expect.stringContaining("/queues/default?status=completed")
    );
    expect(screen.getByText(/exists in the/)).toBeInTheDocument();
    expect(screen.queryByText("exact-task-2")).not.toBeInTheDocument();
    expect(screen.queryByText("local-task-not-matching")).not.toBeInTheDocument();
  });

  it("shows a not-found message and no row when the task doesn't exist (404)", async () => {
    mockedGetTaskInfo.mockRejectedValue({
      response: { status: 404, data: "task not found" },
    });

    renderTasksTable();

    userEvent.type(
      screen.getByPlaceholderText("exact ID…"),
      "no-such-task{enter}"
    );

    expect(
      await screen.findByText("No task with this ID in this queue.")
    ).toBeInTheDocument();
    expect(screen.queryByText("local-task-not-matching")).not.toBeInTheDocument();
  });

  it("reports a failed lookup as an error, not as task-not-found", async () => {
    mockedGetTaskInfo.mockRejectedValue({
      response: { status: 500, data: "redis: connection refused" },
      message: "Request failed with status code 500",
    });

    renderTasksTable();

    userEvent.type(
      screen.getByPlaceholderText("exact ID…"),
      "some-task-id{enter}"
    );

    expect(
      await screen.findByText("Lookup failed: redis: connection refused")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No task with this ID in this queue.")
    ).not.toBeInTheDocument();
  });
});
