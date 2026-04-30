(
  (method_definition
    name: [(property_identifier) (identifier)] @name.definition.method) @definition.method
)

(
  [
    (class
      name: (_) @name.definition.class)
    (class_declaration
      name: (_) @name.definition.class)
  ] @definition.class
)

(
  [
    (function_declaration
      name: (identifier) @name.definition.function)
    (generator_function_declaration
      name: (identifier) @name.definition.function)
  ] @definition.function
)

(
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: [(arrow_function) (function_expression)]))
    (variable_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: [(arrow_function) (function_expression)]))
  ] @definition.function
)

(identifier) @name.reference
(property_identifier) @name.reference
