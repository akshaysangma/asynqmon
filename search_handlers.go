package asynqmon

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/mux"

	"github.com/hibiken/asynq"
)

// ****************************************************************************
// This file defines:
//   - http.Handler for the cross-page task search endpoint
// ****************************************************************************

const (
	searchPageSize       = 500
	searchMatchCap       = 200
	searchDefaultWindow  = 10000
	searchMaxWindow      = 10000
	searchMinQueryLength = 3
	searchTimeout        = 5 * time.Second
)

type searchTasksResponse struct {
	// Matches carry the same per-state DTOs the corresponding list endpoint returns.
	Matches []interface{} `json:"matches"`
	// Number of tasks examined by this request.
	Scanned int `json:"scanned"`
	// State size (from queue stats) at request time.
	Total int `json:"total"`
	// Ascending index to resume scanning from; null when the state is exhausted.
	NextOffset *int `json:"next_offset"`
}

// newSearchTasksHandlerFunc returns a handler for
// GET /queues/{qname}/tasks/search?state=<state>&q=<query>&offset=<int>.
//
// It scans up to `window` tasks of the requested state (in ascending list
// order, starting at `offset`) and returns the ones whose ID, type, or
// formatted payload contains the query, case-insensitively. Matching runs on
// the PayloadFormatter output so search sees exactly what the UI shows.
//
// Consistency caveat: windows are not one atomic snapshot; on a fast-churning
// state, offsets can drift between requests, so a task may be missed or seen
// twice across windows. Zset-backed states (scheduled/retry/archived/completed)
// drift slowly. Archived and completed are scanned newest-first (matching
// their list tabs' display order), so their drift direction is arrival-shifting:
// new arrivals between hops push desc offsets forward, making a previously
// seen task reappear rather than the append-stable "new tasks land past the
// scanned tail" drift the other, ascending-scanned states have.
func newSearchTasksHandlerFunc(inspector *asynq.Inspector, pf PayloadFormatter, rf ResultFormatter, window int) http.HandlerFunc {
	if window <= 0 {
		window = searchDefaultWindow
	}
	if window > searchMaxWindow {
		window = searchMaxWindow
	}
	return func(w http.ResponseWriter, r *http.Request) {
		qname := mux.Vars(r)["qname"]
		query := r.URL.Query()

		q := strings.TrimSpace(query.Get("q"))
		if utf8.RuneCountInString(q) < searchMinQueryLength {
			http.Error(w, fmt.Sprintf("query must be at least %d characters", searchMinQueryLength), http.StatusBadRequest)
			return
		}

		offset := 0
		if s := query.Get("offset"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil {
				http.Error(w, "offset must be an integer", http.StatusBadRequest)
				return
			}
			if n > 0 {
				offset = n
			}
		}

		qinfo, err := inspector.GetQueueInfo(qname)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var (
			list    func(page, size int) ([]*asynq.TaskInfo, error)
			convert func(ti *asynq.TaskInfo) interface{}
			total   int
		)
		state := query.Get("state")
		switch state {
		case "pending":
			total = qinfo.Pending
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListPendingTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			convert = func(ti *asynq.TaskInfo) interface{} { return toPendingTask(ti, pf) }
		case "active":
			total = qinfo.Active
			workers, err := activeWorkersByTaskID(inspector, qname)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListActiveTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			convert = func(ti *asynq.TaskInfo) interface{} {
				t := toActiveTask(ti, pf)
				if wi, ok := workers[t.ID]; ok {
					t.Started = wi.Started.Format(time.RFC3339)
					t.Deadline = wi.Deadline.Format(time.RFC3339)
				} else {
					t.Started = "-"
					t.Deadline = "-"
				}
				return t
			}
		case "scheduled":
			total = qinfo.Scheduled
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListScheduledTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			convert = func(ti *asynq.TaskInfo) interface{} { return toScheduledTask(ti, pf) }
		case "retry":
			total = qinfo.Retry
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListRetryTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			convert = func(ti *asynq.TaskInfo) interface{} { return toRetryTask(ti, pf) }
		case "archived":
			total = qinfo.Archived
			ascList := func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListArchivedTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return listTasksDesc(ascList, total, page, size)
			}
			convert = func(ti *asynq.TaskInfo) interface{} { return toArchivedTask(ti, pf) }
		case "completed":
			total = qinfo.Completed
			ascList := func(page, size int) ([]*asynq.TaskInfo, error) {
				return inspector.ListCompletedTasks(qname, asynq.PageSize(size), asynq.Page(page))
			}
			list = func(page, size int) ([]*asynq.TaskInfo, error) {
				return listTasksDesc(ascList, total, page, size)
			}
			convert = func(ti *asynq.TaskInfo) interface{} { return toCompletedTask(ti, pf, rf) }
		default:
			http.Error(w, fmt.Sprintf("unsupported state %q: must be one of pending, active, scheduled, retry, archived, completed", state), http.StatusBadRequest)
			return
		}

		matches, scanned, exhausted, err := scanForMatches(list, convert, pf, q, offset, window)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		resp := searchTasksResponse{
			Matches: matches,
			Scanned: scanned,
			Total:   total,
		}
		if !exhausted && offset+scanned < total {
			next := offset + scanned
			resp.NextOffset = &next
		}
		writeResponseJSON(w, resp)
	}
}

// scanForMatches examines up to `window` tasks starting at ascending index
// `offset`, fetching Inspector pages of searchPageSize. It stops early when
// the match cap fills or the elapsed-time budget runs out (Inspector calls
// take no context, so the budget is checked between page fetches). exhausted
// reports whether the end of the state's list was reached.
func scanForMatches(
	list func(page, size int) ([]*asynq.TaskInfo, error),
	convert func(ti *asynq.TaskInfo) interface{},
	pf PayloadFormatter,
	query string,
	offset, window int,
) (matches []interface{}, scanned int, exhausted bool, err error) {
	loweredQuery := strings.ToLower(query)
	matches = make([]interface{}, 0)
	page := offset/searchPageSize + 1
	skip := offset % searchPageSize
	start := time.Now()
	for scanned < window && len(matches) < searchMatchCap {
		if time.Since(start) > searchTimeout {
			break
		}
		tasks, err := list(page, searchPageSize)
		if err != nil {
			return nil, 0, false, err
		}
		if skip >= len(tasks) {
			exhausted = true
			break
		}
		remaining := tasks[skip:]
		consumed := 0
		for _, ti := range remaining {
			scanned++
			consumed++
			if taskMatchesQuery(ti, loweredQuery, pf) {
				matches = append(matches, convert(ti))
			}
			if scanned >= window || len(matches) >= searchMatchCap {
				break
			}
		}
		if consumed == len(remaining) && len(tasks) < searchPageSize {
			exhausted = true
		}
		skip = 0
		page++
	}
	return matches, scanned, exhausted, nil
}

// taskMatchesQuery reports whether the task's ID, type, or formatted payload
// contains loweredQuery (which must already be lowercase).
func taskMatchesQuery(ti *asynq.TaskInfo, loweredQuery string, pf PayloadFormatter) bool {
	return strings.Contains(strings.ToLower(ti.ID), loweredQuery) ||
		strings.Contains(strings.ToLower(ti.Type), loweredQuery) ||
		strings.Contains(strings.ToLower(pf.FormatPayload(ti.Type, ti.Payload)), loweredQuery)
}

// activeWorkersByTaskID maps task ID to worker info for the queue's active
// workers, mirroring the enrichment the active-task list endpoint performs.
func activeWorkersByTaskID(inspector *asynq.Inspector, qname string) (map[string]*asynq.WorkerInfo, error) {
	servers, err := inspector.Servers()
	if err != nil {
		return nil, err
	}
	m := make(map[string]*asynq.WorkerInfo)
	for _, srv := range servers {
		for _, w := range srv.ActiveWorkers {
			if w.Queue == qname {
				m[w.TaskID] = w
			}
		}
	}
	return m, nil
}
