/**
 * The language in a nutshell, for a model that has never seen Hindsight (checked against SPEC
 * §2–§9 and the studio's cheat sheet). It is part of every prompt, so it stays short.
 */
export const LANGUAGE_CHEAT_SHEET = `Hindsight is a small dynamically typed language.
Values: numbers are doubles (7 / 2 == 3.5, 10 / 4 == 2.5; % takes the divisor's sign), strings "hi {name}" (braces interpolate; write \\{ for a literal brace), true false nil, lists [1, 2, 3], records {x: 1, "two words": 2}, ranges 0..10 (end excluded) and 1..=5.
Bindings: let x = 1 (fixed), var n = 0 (can change), n += 1, let [a, b] = [1, 2].
Functions: fn add(a, b) { a + b } (the last expression is the result), return x, lambdas |x| x * x.
Contracts: fn f(xs) requires len(xs) > 0 ensures result >= 0 { ... } (result is the returned value).
Control: if c { a } else { b } (an expression), while c { }, for x in xs { }, for i in 0..len(xs) { }, break, continue, match v { 0 | 1 => "tiny", [first, ...rest] => first, {name} => name, n if n > 9 => "big", _ => "other" }.
Operators: + (numbers, string + string, list + list), - * / % **, == != (structural for lists and records), < <= > >=, and or not.
Pipes: xs |> map(|x| x * 2) |> sum() means sum(map(xs, |x| x * 2)).
Lists and records: xs[0], xs[-1] (from the end), push(xs, 4), pop(xs), [...xs, 5], r.name, r["key"], {...r, y: 3}.
Builtins: print str repr type len num range push pop insert remove slice sort reverse join contains keys values entries has get delete split upper lower trim map filter reduce each find any all sum zip enumerate min max abs floor ceil round sqrt.
Comments: // to the end of the line, /* nested /* block */ */.`
