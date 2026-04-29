(
  (function_signature
    name: (identifier) @name.definition.function) @definition.function
)

(
  (function_declaration
    name: (identifier) @name.definition.function) @definition.function
)

(
  (method_signature
    name: [(property_identifier) (identifier)] @name.definition.method) @definition.method
)

(
  (method_definition
    name: [(property_identifier) (identifier)] @name.definition.method) @definition.method
)

(
  (abstract_method_signature
    name: [(property_identifier) (identifier)] @name.definition.method) @definition.method
)

(
  (abstract_class_declaration
    name: (type_identifier) @name.definition.class) @definition.class
)

(
  (class_declaration
    name: (type_identifier) @name.definition.class) @definition.class
)

(
  (module
    name: [(identifier) (string)] @name.definition.module) @definition.module
)

(
  (interface_declaration
    name: (type_identifier) @name.definition.interface) @definition.interface
)

(
  (enum_declaration
    name: (identifier) @name.definition.enum) @definition.enum
)

(
  (type_alias_declaration
    name: (type_identifier) @name.definition.type) @definition.type
)

(
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)])) @definition.function
)

(
  (variable_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)])) @definition.function
)

(
  (pair
    key: [(property_identifier) (identifier)] @name.definition.method
    value: [(arrow_function) (function_expression)]) @definition.method
)

(
  (public_field_definition
    name: [(property_identifier) (identifier)] @name.definition.method
    value: [(arrow_function) (function_expression)]) @definition.method
)

(identifier) @name.reference
(property_identifier) @name.reference
(type_identifier) @name.reference
