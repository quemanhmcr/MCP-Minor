(
  (method_definition
    name: [(property_identifier) (identifier) (private_property_identifier) (computed_property_name)] @name.definition.method) @definition.method
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
        value: [(arrow_function) (function_expression) (generator_function)]))
    (variable_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: [(arrow_function) (function_expression) (generator_function)]))
  ] @definition.function
)

(identifier) @name.reference
(property_identifier) @name.reference
