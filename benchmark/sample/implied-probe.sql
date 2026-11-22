-- Two tables for the SchemaSpy probe: the parent key has the same name as the child column.
CREATE TABLE customers (customer_id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE invoices (id bigserial PRIMARY KEY, customer_id bigint NOT NULL);
