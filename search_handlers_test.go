package asynqmon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/hibiken/asynq"
)

// identityConvert is the "convert" stand-in used across these tests: the
// search response conversion step is irrelevant to scanForMatches's ordering
// and offset bookkeeping, so tests assert directly on the *asynq.TaskInfo.
func identityConvert(ti *asynq.TaskInfo) interface{} { return ti }

// wrapDesc builds the same-shape lister search_handlers.go installs for the
// archived/completed states: a desc page K served from an ascending source
// via listTasksDesc.
func wrapDesc(ascList func(page, size int) ([]*asynq.TaskInfo, error), total int) func(page, size int) ([]*asynq.TaskInfo, error) {
	return func(page, size int) ([]*asynq.TaskInfo, error) {
		return listTasksDesc(ascList, total, page, size)
	}
}

func matchIDs(t *testing.T, matches []interface{}) []string {
	t.Helper()
	ids := make([]string, len(matches))
	for i, m := range matches {
		ti, ok := m.(*asynq.TaskInfo)
		if !ok {
			t.Fatalf("match %d is not a *asynq.TaskInfo: %T", i, m)
		}
		ids[i] = ti.ID
	}
	return ids
}

func TestScanForMatches_DescNewestFirst(t *testing.T) {
	const total = 1234
	tasks := makeAscTasks(total)
	// Sparse marker subset (ascending indices), including the very oldest
	// (0) and very newest (total-1) tasks.
	markerAsc := []int{0, 100, 500, 900, total - 1}
	for _, i := range markerAsc {
		tasks[i].Type = "target"
	}
	list := wrapDesc(ascLister(tasks), total)

	matches, scanned, exhausted, err := scanForMatches(list, identityConvert, DefaultPayloadFormatter, "target", 0, total+500)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !exhausted {
		t.Fatalf("want exhausted=true scanning the whole state, got false (scanned=%d)", scanned)
	}
	// Newest-first: descending over markerAsc.
	want := []string{
		tasks[total-1].ID,
		tasks[900].ID,
		tasks[500].ID,
		tasks[100].ID,
		tasks[0].ID,
	}
	got := matchIDs(t, matches)
	if len(got) != len(want) {
		t.Fatalf("got %d matches %v, want %d matches %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("match %d: got %q, want %q (full got=%v)", i, got[i], want[i], got)
		}
	}
}

func TestScanForMatches_DescNextOffsetContinuity(t *testing.T) {
	const total = 1234
	const window = 600
	tasks := makeAscTasks(total)
	// Markers straddle every hop/page boundary so a gap or a double-count
	// at any seam would show up as a missing or duplicated match.
	markerAsc := []int{0, total - 1, 634, 633, 34, 33}
	for _, i := range markerAsc {
		tasks[i].Type = "target"
	}
	list := wrapDesc(ascLister(tasks), total)

	type hop struct {
		offset        int
		wantScanned   int
		wantExhausted bool
	}
	hops := []hop{
		{0, 600, false},
		{600, 600, false},
		{1200, 34, true},
	}

	var allMatches []string
	nextOffset := 0
	for i, h := range hops {
		if nextOffset != h.offset {
			t.Fatalf("hop %d: computed next offset %d, want %d", i, nextOffset, h.offset)
		}
		matches, scanned, exhausted, err := scanForMatches(list, identityConvert, DefaultPayloadFormatter, "target", h.offset, window)
		if err != nil {
			t.Fatalf("hop %d: unexpected error: %v", i, err)
		}
		if scanned != h.wantScanned {
			t.Fatalf("hop %d: scanned=%d, want %d", i, scanned, h.wantScanned)
		}
		if exhausted != h.wantExhausted {
			t.Fatalf("hop %d: exhausted=%v, want %v", i, exhausted, h.wantExhausted)
		}
		allMatches = append(allMatches, matchIDs(t, matches)...)
		nextOffset = h.offset + scanned
	}
	if nextOffset != total {
		t.Fatalf("concatenated hops covered up to offset %d, want %d (gap or overlap)", nextOffset, total)
	}

	// Every marker seen exactly once across the three hops.
	seen := make(map[string]int)
	for _, id := range allMatches {
		seen[id]++
	}
	if len(seen) != len(markerAsc) {
		t.Fatalf("got %d distinct matched markers, want %d (matches=%v)", len(seen), len(markerAsc), allMatches)
	}
	for _, i := range markerAsc {
		id := tasks[i].ID
		if c := seen[id]; c != 1 {
			t.Fatalf("marker %q seen %d times across hops, want exactly 1", id, c)
		}
	}
}

func TestScanForMatches_DescAlignedTotalExhaustion(t *testing.T) {
	const total = 1000 // exact multiple of searchPageSize (500): no straddle.
	tasks := makeAscTasks(total)

	callCount := 0
	countingAscList := func(page, size int) ([]*asynq.TaskInfo, error) {
		callCount++
		return ascLister(tasks)(page, size)
	}
	list := wrapDesc(countingAscList, total)

	matches, scanned, exhausted, err := scanForMatches(list, identityConvert, DefaultPayloadFormatter, "nomatch", 0, total+500)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("want no matches, got %v", matchIDs(t, matches))
	}
	if scanned != total {
		t.Fatalf("scanned=%d, want %d", scanned, total)
	}
	if !exhausted {
		t.Fatalf("want exhausted=true at the aligned boundary")
	}
	// Two full desc pages cover the whole state; the page past the boundary
	// is recognized as out-of-range inside listTasksDesc itself (end <= 0)
	// without ever calling the underlying ascending lister.
	if callCount != 2 {
		t.Fatalf("underlying lister called %d times, want exactly 2 (no extra fetch past the boundary)", callCount)
	}
}

func TestScanForMatches_AscUnchanged(t *testing.T) {
	const total = 50
	const window = 30
	tasks := makeAscTasks(total)
	tasks[5].Type = "target"
	tasks[45].Type = "target"
	list := ascLister(tasks) // no listTasksDesc wrap: pending/active/scheduled/retry shape.

	matches1, scanned1, exhausted1, err := scanForMatches(list, identityConvert, DefaultPayloadFormatter, "target", 0, window)
	if err != nil {
		t.Fatalf("hop 1: unexpected error: %v", err)
	}
	if scanned1 != window {
		t.Fatalf("hop 1: scanned=%d, want %d", scanned1, window)
	}
	if exhausted1 {
		t.Fatalf("hop 1: want exhausted=false, more tasks remain")
	}
	got1 := matchIDs(t, matches1)
	if len(got1) != 1 || got1[0] != tasks[5].ID {
		t.Fatalf("hop 1: got matches %v, want [%q]", got1, tasks[5].ID)
	}

	offset2 := 0 + scanned1
	matches2, scanned2, exhausted2, err := scanForMatches(list, identityConvert, DefaultPayloadFormatter, "target", offset2, window)
	if err != nil {
		t.Fatalf("hop 2: unexpected error: %v", err)
	}
	wantScanned2 := total - window
	if scanned2 != wantScanned2 {
		t.Fatalf("hop 2: scanned=%d, want %d", scanned2, wantScanned2)
	}
	if !exhausted2 {
		t.Fatalf("hop 2: want exhausted=true, state fully consumed")
	}
	got2 := matchIDs(t, matches2)
	if len(got2) != 1 || got2[0] != tasks[45].ID {
		t.Fatalf("hop 2: got matches %v, want [%q]", got2, tasks[45].ID)
	}
}

// TestSearchTasksHandler_FullTaskIDGoesThroughScan is a regression test for
// the removal of the exact-ID fast path: a query that happens to be a real
// task's full UUID must still be answered by the progressive scan (matching
// the ID as a substring), and the response must carry no "hint" key. Before
// the fast path was removed, this query short-circuited to an O(1)
// GetTaskInfo lookup and the response carried a "hint" key with Scanned left
// at its zero value.
//
// Requires a reachable redis instance; skips itself otherwise.
func TestSearchTasksHandler_FullTaskIDGoesThroughScan(t *testing.T) {
	redisOpt := asynq.RedisClientOpt{Addr: "localhost:6379"}
	client := asynq.NewClient(redisOpt)
	if err := client.Ping(); err != nil {
		client.Close()
		t.Skipf("redis not reachable at %s, skipping integration test: %v", redisOpt.Addr, err)
	}

	inspector := asynq.NewInspector(redisOpt)
	// Registered before the queue cleanup below so it runs after it:
	// t.Cleanup runs LIFO, and the queue delete needs a live connection.
	t.Cleanup(func() {
		inspector.Close()
		client.Close()
	})

	qname := fmt.Sprintf("search_fastpath_removed_test_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		if err := inspector.DeleteQueue(qname, true); err != nil {
			t.Errorf("cleanup: delete queue %q: %v", qname, err)
		}
	})

	ti, err := client.Enqueue(asynq.NewTask("regression_task", []byte(`{"marker":"fastpath-removed"}`)), asynq.Queue(qname))
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	handler := newSearchTasksHandlerFunc(inspector, DefaultPayloadFormatter, DefaultResultFormatter, 0)
	router := mux.NewRouter()
	router.HandleFunc("/queues/{qname}/tasks/search", handler).Methods(http.MethodGet)

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/queues/%s/tasks/search?state=pending&q=%s", qname, ti.ID), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v (body=%s)", err, rec.Body.String())
	}

	if _, hasHint := body["hint"]; hasHint {
		t.Fatalf(`response contains a "hint" key, want none now the fast path is removed: %v`, body)
	}

	scanned, _ := body["scanned"].(float64)
	if scanned < 1 {
		t.Fatalf("scanned = %v, want >= 1 (proves the query went through scanForMatches, not the exact-ID fast path)", body["scanned"])
	}

	matches, _ := body["matches"].([]interface{})
	if len(matches) != 1 {
		t.Fatalf("want exactly 1 match for the full-UUID query, got %d: %v", len(matches), matches)
	}
	match, ok := matches[0].(map[string]interface{})
	if !ok {
		t.Fatalf("match is not a JSON object: %#v", matches[0])
	}
	if match["id"] != ti.ID {
		t.Fatalf("match id = %v, want %q (matched by ID substring during the scan)", match["id"], ti.ID)
	}
}
