-- Sample schema for the ER-diagram comparison: a small online shop.
-- 12 tables. Only 3 foreign keys are declared; every other `*_id` column
-- points at another table by naming convention only.

CREATE TABLE users (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  display_name text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'Customer accounts';

CREATE TABLE addresses (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  postal_code text NOT NULL,
  line1       text NOT NULL,
  city        text NOT NULL
);
COMMENT ON TABLE addresses IS 'Shipping addresses of a user';

CREATE TABLE categories (
  id          bigserial PRIMARY KEY,
  parent_id   bigint,
  name        text NOT NULL
);
COMMENT ON TABLE categories IS 'Product categories; parent_id builds a tree';

CREATE TABLE products (
  id          bigserial PRIMARY KEY,
  category_id bigint NOT NULL,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  display_name text,
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);
COMMENT ON TABLE products IS 'Items for sale';

CREATE TABLE product_images (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL,
  url         text NOT NULL,
  position    integer NOT NULL DEFAULT 0
);

CREATE TABLE coupons (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  percent_off   integer NOT NULL CHECK (percent_off BETWEEN 1 AND 100)
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  address_id  bigint NOT NULL,
  coupon_id   bigint,
  status      text NOT NULL DEFAULT 'new',
  placed_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE orders IS 'One purchase by one user';

CREATE TABLE order_items (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders (id),
  product_id  bigint NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL CHECK (quantity > 0)
);

CREATE TABLE payments (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders (id),
  amount_cents integer NOT NULL,
  paid_at     timestamptz
);

CREATE TABLE shipments (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL,
  carrier     text NOT NULL,
  shipped_at  timestamptz
);

CREATE TABLE reviews (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL,
  user_id     bigint NOT NULL,
  rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text
);

CREATE TABLE carts (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
