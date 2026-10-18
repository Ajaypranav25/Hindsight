/**
 * The library (prelude): docs/SPEC.md Appendix A, verbatim. Library functions are ordinary
 * Hindsight code, recorded like user code and shown as library frames. prelude.test.ts checks that
 * this text matches the spec exactly; change both together.
 */
export const PRELUDE_SOURCE = String.raw`fn map(xs, f) {
  var out = []
  for x in list(xs) {
    push(out, f(x))
  }
  out
}

fn filter(xs, f) {
  var out = []
  for x in list(xs) {
    if f(x) { push(out, x) }
  }
  out
}

fn reduce(xs, f, init) {
  var acc = init
  for x in list(xs) {
    acc = f(acc, x)
  }
  acc
}

fn each(xs, f) {
  for x in list(xs) {
    f(x)
  }
  nil
}

fn find(xs, f) {
  for x in list(xs) {
    if f(x) { return x }
  }
  nil
}

fn find_index(xs, f) {
  var i = 0
  for x in list(xs) {
    if f(x) { return i }
    i += 1
  }
  -1
}

fn any(xs, f) {
  for x in list(xs) {
    if f(x) { return true }
  }
  false
}

fn all(xs, f) {
  for x in list(xs) {
    if not f(x) { return false }
  }
  true
}

fn count(xs, f) {
  var n = 0
  for x in list(xs) {
    if f(x) { n += 1 }
  }
  n
}

fn sum(xs) {
  var total = 0
  for x in list(xs) {
    total = total + x
  }
  total
}

fn sort_by(xs, key) {
  var items = []
  for x in list(xs) {
    push(items, [key(x), x])
  }
  let n = len(items)
  var width = 1
  while width < n {
    var merged = []
    var lo = 0
    while lo < n {
      let mid = min(lo + width, n)
      let hi = min(lo + 2 * width, n)
      var i = lo
      var j = mid
      while i < mid and j < hi {
        if items[j][0] < items[i][0] {
          push(merged, items[j])
          j += 1
        } else {
          push(merged, items[i])
          i += 1
        }
      }
      while i < mid {
        push(merged, items[i])
        i += 1
      }
      while j < hi {
        push(merged, items[j])
        j += 1
      }
      lo = hi
    }
    items = merged
    width = width * 2
  }
  var out = []
  for pair in items {
    push(out, pair[1])
  }
  out
}

fn zip(a, b) {
  let left = list(a)
  let right = list(b)
  let n = min(len(left), len(right))
  var out = []
  var i = 0
  while i < n {
    push(out, [left[i], right[i]])
    i += 1
  }
  out
}

fn enumerate(xs) {
  var out = []
  var i = 0
  for x in list(xs) {
    push(out, [i, x])
    i += 1
  }
  out
}

fn flat_map(xs, f) {
  var out = []
  for x in list(xs) {
    for y in list(f(x)) {
      push(out, y)
    }
  }
  out
}

fn flatten(xs) {
  var out = []
  for x in list(xs) {
    for y in list(x) {
      push(out, y)
    }
  }
  out
}

fn take(xs, n) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'take' expects a non-negative integer")
  var out = []
  for x in list(xs) {
    if len(out) >= n { break }
    push(out, x)
  }
  out
}

fn drop(xs, n) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'drop' expects a non-negative integer")
  var out = []
  var i = 0
  for x in list(xs) {
    if i >= n { push(out, x) }
    i += 1
  }
  out
}

fn uniq(xs) {
  var out = []
  for x in list(xs) {
    if not contains(out, x) { push(out, x) }
  }
  out
}

fn group_by(xs, key) {
  var groups = {}
  for x in list(xs) {
    let k = str(key(x))
    if has(groups, k) {
      push(groups[k], x)
    } else {
      groups[k] = [x]
    }
  }
  groups
}

fn min_by(xs, f) {
  var best = nil
  var best_key = nil
  var first = true
  for x in list(xs) {
    let k = f(x)
    if first or k < best_key {
      best = x
      best_key = k
      first = false
    }
  }
  best
}

fn max_by(xs, f) {
  var best = nil
  var best_key = nil
  var first = true
  for x in list(xs) {
    let k = f(x)
    if first or k > best_key {
      best = x
      best_key = k
      first = false
    }
  }
  best
}

fn times(n, f) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'times' expects a non-negative integer")
  var out = []
  var i = 0
  while i < n {
    push(out, f(i))
    i += 1
  }
  out
}

fn chunk(xs, n) {
  assert(type(n) == "number" and n >= 1 and n == floor(n), "'chunk' expects a positive integer")
  var out = []
  var current = []
  for x in list(xs) {
    push(current, x)
    if len(current) == n {
      push(out, current)
      current = []
    }
  }
  if len(current) > 0 { push(out, current) }
  out
}
`
