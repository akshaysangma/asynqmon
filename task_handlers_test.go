package asynqmon

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hibiken/asynq"
)

// makeAscTasks builds a synthetic ascending-ordered task slice of length n
// with IDs "task-0000".."task-{n-1}", mirroring how asynq's archived/completed
// zsets are stored (ascending by score).
func makeAscTasks(n int) []*asynq.TaskInfo {
	tasks := make([]*asynq.TaskInfo, n)
	for i := 0; i < n; i++ {
		tasks[i] = &asynq.TaskInfo{ID: fmt.Sprintf("task-%04d", i)}
	}
	return tasks
}

// ascLister returns a page,size -> tasks lister over an in-memory ascending
// slice, mirroring asynq.Inspector's ListXTasks pagination (1-based page,
// returns whatever is available with no error at the tail).
func ascLister(tasks []*asynq.TaskInfo) func(page, size int) ([]*asynq.TaskInfo, error) {
	return func(page, size int) ([]*asynq.TaskInfo, error) {
		if size <= 0 || page <= 0 {
			return nil, nil
		}
		start := (page - 1) * size
		if start >= len(tasks) {
			return nil, nil
		}
		end := start + size
		if end > len(tasks) {
			end = len(tasks)
		}
		return tasks[start:end], nil
	}
}

func idsOf(tasks []*asynq.TaskInfo) []string {
	ids := make([]string, len(tasks))
	for i, t := range tasks {
		ids[i] = t.ID
	}
	return ids
}

func idRange(from, to int) []string {
	// inclusive of from, inclusive of to; supports descending (from > to).
	var ids []string
	if from <= to {
		for i := from; i <= to; i++ {
			ids = append(ids, fmt.Sprintf("task-%04d", i))
		}
	} else {
		for i := from; i >= to; i-- {
			ids = append(ids, fmt.Sprintf("task-%04d", i))
		}
	}
	return ids
}

func assertIDs(t *testing.T, got []*asynq.TaskInfo, want []string) {
	t.Helper()
	gotIDs := idsOf(got)
	if len(gotIDs) != len(want) {
		t.Fatalf("got %d tasks %v, want %d tasks %v", len(gotIDs), gotIDs, len(want), want)
	}
	for i := range want {
		if gotIDs[i] != want[i] {
			t.Fatalf("index %d: got %q, want %q (full got=%v want=%v)", i, gotIDs[i], want[i], gotIDs, want)
		}
	}
}

func TestListTasksDesc_AlignedTotal(t *testing.T) {
	tasks := makeAscTasks(100)
	list := ascLister(tasks)
	const total, size = 100, 20

	page1, err := listTasksDesc(list, total, 1, size)
	if err != nil {
		t.Fatalf("page 1: unexpected error: %v", err)
	}
	assertIDs(t, page1, idRange(99, 80))

	page5, err := listTasksDesc(list, total, 5, size)
	if err != nil {
		t.Fatalf("page 5: unexpected error: %v", err)
	}
	assertIDs(t, page5, idRange(19, 0))

	page6, err := listTasksDesc(list, total, 6, size)
	if err != nil {
		t.Fatalf("page 6: unexpected error: %v", err)
	}
	if page6 != nil {
		t.Fatalf("page 6: want nil, got %v", idsOf(page6))
	}
}

func TestListTasksDesc_MisalignedTotal(t *testing.T) {
	tasks := makeAscTasks(23)
	list := ascLister(tasks)
	const total, size = 23, 5

	cases := []struct {
		page      int
		fromTo    [2]int
		wantEmpty bool
	}{
		{1, [2]int{22, 18}, false},
		{2, [2]int{17, 13}, false},
		{3, [2]int{12, 8}, false},
		{4, [2]int{7, 3}, false},
		{5, [2]int{2, 0}, false},
		{6, [2]int{0, 0}, true},
	}
	for _, c := range cases {
		got, err := listTasksDesc(list, total, c.page, size)
		if err != nil {
			t.Fatalf("page %d: unexpected error: %v", c.page, err)
		}
		if c.wantEmpty {
			if got != nil {
				t.Fatalf("page %d: want nil, got %v", c.page, idsOf(got))
			}
			continue
		}
		assertIDs(t, got, idRange(c.fromTo[0], c.fromTo[1]))
	}
}

func TestListTasksDesc_InvalidArgs(t *testing.T) {
	tasks := makeAscTasks(10)
	list := ascLister(tasks)

	for _, tc := range []struct {
		name             string
		pageNum, pageSize int
	}{
		{"zero page size", 1, 0},
		{"negative page size", 1, -5},
		{"zero page num", 0, 5},
		{"negative page num", -1, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := listTasksDesc(list, 10, tc.pageNum, tc.pageSize)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != nil {
				t.Fatalf("want nil, got %v", idsOf(got))
			}
		})
	}
}

func TestListTasksDesc_DriftClamp(t *testing.T) {
	// Stats claim 100 tasks, but the lister actually only holds 20 (state
	// shrank between the stats fetch and the list fetch).
	tasks := makeAscTasks(20)
	list := ascLister(tasks)

	got, err := listTasksDesc(list, 100, 1, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) > len(tasks) {
		t.Fatalf("got %d tasks, more than the %d available", len(got), len(tasks))
	}
}

func TestListTasksDesc_ErrorPropagation(t *testing.T) {
	wantErr := errors.New("redis unavailable")
	failingList := func(page, size int) ([]*asynq.TaskInfo, error) {
		return nil, wantErr
	}

	got, err := listTasksDesc(failingList, 100, 1, 20)
	if !errors.Is(err, wantErr) {
		t.Fatalf("got err %v, want %v", err, wantErr)
	}
	if got != nil {
		t.Fatalf("want nil tasks alongside error, got %v", idsOf(got))
	}
}

func TestListTasksOrdered(t *testing.T) {
	t.Run("desc order delegates to listTasksDesc math", func(t *testing.T) {
		tasks := makeAscTasks(100)
		list := ascLister(tasks)
		req := httptest.NewRequest(http.MethodGet, "/?order=desc", nil)

		got, err := listTasksOrdered(req, list, 100, 1, 20)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		assertIDs(t, got, idRange(99, 80))
	})

	t.Run("no order param passes through to list", func(t *testing.T) {
		calls := 0
		var gotPage, gotSize int
		list := func(page, size int) ([]*asynq.TaskInfo, error) {
			calls++
			gotPage, gotSize = page, size
			return makeAscTasks(size), nil
		}
		req := httptest.NewRequest(http.MethodGet, "/", nil)

		got, err := listTasksOrdered(req, list, 100, 3, 20)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if calls != 1 {
			t.Fatalf("want list called once, got %d calls", calls)
		}
		if gotPage != 3 || gotSize != 20 {
			t.Fatalf("want list called with (3, 20), got (%d, %d)", gotPage, gotSize)
		}
		if len(got) != 20 {
			t.Fatalf("want passthrough result of len 20, got %d", len(got))
		}
	})

	t.Run("desc order propagates lister error", func(t *testing.T) {
		wantErr := errors.New("redis unavailable")
		failingList := func(page, size int) ([]*asynq.TaskInfo, error) {
			return nil, wantErr
		}
		req := httptest.NewRequest(http.MethodGet, "/?order=desc", nil)

		_, err := listTasksOrdered(req, failingList, 100, 1, 20)
		if !errors.Is(err, wantErr) {
			t.Fatalf("got err %v, want %v", err, wantErr)
		}
	})

	t.Run("passthrough propagates lister error", func(t *testing.T) {
		wantErr := errors.New("redis unavailable")
		failingList := func(page, size int) ([]*asynq.TaskInfo, error) {
			return nil, wantErr
		}
		req := httptest.NewRequest(http.MethodGet, "/", nil)

		_, err := listTasksOrdered(req, failingList, 100, 1, 20)
		if !errors.Is(err, wantErr) {
			t.Fatalf("got err %v, want %v", err, wantErr)
		}
	})
}
