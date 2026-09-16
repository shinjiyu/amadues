import Lake
open Lake DSL

package «collatz» where
  version := v!"0.1.0"

@[default_target]
lean_lib «Collatz»
