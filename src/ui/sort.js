/* Sắp xếp danh sách tin trong một thùng. Thuần — UI import, check.js kiểm. KHÔNG import gì. */

export const SORTS = [
  { id: "newest", label: "mới thêm" },
  { id: "oldest", label: "cũ nhất" },
  { id: "deadline", label: "deadline gần nhất" },
];

const byFound = (a, b) => String(b.foundAt ?? "").localeCompare(String(a.foundAt ?? "")) || String(a.id).localeCompare(String(b.id));

export function sortJobs(jobs, mode) {
  const out = [...jobs];
  if (mode === "oldest") return out.sort((a, b) => -byFound(a, b));
  if (mode === "deadline") {
    // Có deadline lên trước, gần nhất trước; trống xếp cuối và trong nhóm trống thì theo mới thêm.
    return out.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline) || byFound(a, b);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return byFound(a, b);
    });
  }
  return out.sort(byFound);
}
