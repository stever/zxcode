// The GraphQL schema: the subset of Hasura's auto-generated surface that the
// three consumers (apps/web, apps/auth, apps/gif-service) actually use, plus
// the four compile actions. Field and type names must match Hasura's exactly —
// the client documents are unchanged.
//
// Column- and row-level security is enforced at execution time (src/tables.ts
// holds the per-role rules carried over from hasura/metadata), so admin-only
// tables like session appear in the schema but reject non-admin requests.

export const sdl = /* GraphQL */ `
scalar uuid
scalar timestamptz
scalar jsonb

enum order_by {
  asc
  asc_nulls_first
  asc_nulls_last
  desc
  desc_nulls_first
  desc_nulls_last
}

input uuid_comparison_exp {
  _eq: uuid
  _neq: uuid
  _in: [uuid!]
  _is_null: Boolean
}

input String_comparison_exp {
  _eq: String
  _neq: String
  _in: [String!]
  _is_null: Boolean
}

input Boolean_comparison_exp {
  _eq: Boolean
  _neq: Boolean
  _is_null: Boolean
}

input Int_comparison_exp {
  _eq: Int
  _neq: Int
  _in: [Int!]
  _gt: Int
  _gte: Int
  _lt: Int
  _lte: Int
  _is_null: Boolean
}

input timestamptz_comparison_exp {
  _eq: timestamptz
  _neq: timestamptz
  _gt: timestamptz
  _gte: timestamptz
  _lt: timestamptz
  _lte: timestamptz
  _is_null: Boolean
}

# ---------------------------------------------------------------- user

type user {
  user_id: uuid!
  username: String!
  greeting_name: String
  full_name: String
  email_address: String
  created_at: timestamptz
  slug: String!
  profile_is_public: Boolean!
  bio: String
  avatar_variant: Int
  custom_avatar_data: jsonb
  projects(where: project_bool_exp, order_by: [project_order_by!], limit: Int, offset: Int): [project!]!
  projects_aggregate(where: project_bool_exp): project_aggregate!
  starred_projects(where: project_star_bool_exp, order_by: [project_star_order_by!], limit: Int, offset: Int): [project_star!]!
  starred_projects_aggregate(where: project_star_bool_exp): project_star_aggregate!
  followers(where: user_follows_bool_exp, order_by: [user_follows_order_by!], limit: Int, offset: Int): [user_follows!]!
  followers_aggregate(where: user_follows_bool_exp): user_follows_aggregate!
  following(where: user_follows_bool_exp, order_by: [user_follows_order_by!], limit: Int, offset: Int): [user_follows!]!
  following_aggregate(where: user_follows_bool_exp): user_follows_aggregate!
  user_roles: [user_role!]!
}

input user_bool_exp {
  _and: [user_bool_exp!]
  _or: [user_bool_exp!]
  _not: user_bool_exp
  user_id: uuid_comparison_exp
  username: String_comparison_exp
  greeting_name: String_comparison_exp
  full_name: String_comparison_exp
  email_address: String_comparison_exp
  created_at: timestamptz_comparison_exp
  slug: String_comparison_exp
  profile_is_public: Boolean_comparison_exp
  bio: String_comparison_exp
  avatar_variant: Int_comparison_exp
  projects: project_bool_exp
  starred_projects: project_star_bool_exp
  followers: user_follows_bool_exp
  following: user_follows_bool_exp
}

input user_order_by {
  user_id: order_by
  username: order_by
  greeting_name: order_by
  created_at: order_by
  slug: order_by
  profile_is_public: order_by
  avatar_variant: order_by
  projects_aggregate: project_aggregate_order_by
  starred_projects_aggregate: project_star_aggregate_order_by
  followers_aggregate: user_follows_aggregate_order_by
  following_aggregate: user_follows_aggregate_order_by
}

type user_aggregate {
  aggregate: user_aggregate_fields
}

type user_aggregate_fields {
  count: Int!
}

input user_set_input {
  greeting_name: String
  full_name: String
  email_address: String
  bio: String
  profile_is_public: Boolean
  slug: String
  avatar_variant: Int
  custom_avatar_data: jsonb
}

input user_insert_input {
  username: String
  greeting_name: String
  full_name: String
  email_address: String
  slug: String
  profile_is_public: Boolean
  bio: String
  avatar_variant: Int
  custom_avatar_data: jsonb
}

input user_pk_columns_input {
  user_id: uuid!
}

type user_mutation_response {
  affected_rows: Int!
}

# ---------------------------------------------------------------- project

type project {
  project_id: uuid!
  title: String!
  code: String!
  owner_user_id: uuid
  updated_at: timestamptz
  created_at: timestamptz
  lang: String!
  is_public: Boolean!
  slug: String!
  display_order: Int
  machine: String!
  owner: user
  user: user
  files(where: project_file_bool_exp, order_by: [project_file_order_by!], limit: Int, offset: Int): [project_file!]!
  files_aggregate(where: project_file_bool_exp): project_file_aggregate!
  stars(where: project_star_bool_exp, order_by: [project_star_order_by!], limit: Int, offset: Int): [project_star!]!
  stars_aggregate(where: project_star_bool_exp): project_star_aggregate!
}

input project_bool_exp {
  _and: [project_bool_exp!]
  _or: [project_bool_exp!]
  _not: project_bool_exp
  project_id: uuid_comparison_exp
  title: String_comparison_exp
  code: String_comparison_exp
  owner_user_id: uuid_comparison_exp
  updated_at: timestamptz_comparison_exp
  created_at: timestamptz_comparison_exp
  lang: String_comparison_exp
  is_public: Boolean_comparison_exp
  slug: String_comparison_exp
  display_order: Int_comparison_exp
  machine: String_comparison_exp
  owner: user_bool_exp
  user: user_bool_exp
  files: project_file_bool_exp
  stars: project_star_bool_exp
}

input project_order_by {
  project_id: order_by
  title: order_by
  owner_user_id: order_by
  updated_at: order_by
  created_at: order_by
  lang: order_by
  is_public: order_by
  slug: order_by
  display_order: order_by
  machine: order_by
}

input project_aggregate_order_by {
  count: order_by
  max: project_max_order_by
}

input project_max_order_by {
  updated_at: order_by
  created_at: order_by
  display_order: order_by
}

type project_aggregate {
  aggregate: project_aggregate_fields
}

type project_aggregate_fields {
  count: Int!
}

input project_set_input {
  code: String
  display_order: Int
  machine: String
  title: String
  is_public: Boolean
  slug: String
}

input project_insert_input {
  title: String
  code: String
  lang: String
  slug: String
  machine: String
  is_public: Boolean
  files: project_file_arr_rel_insert_input
}

input project_pk_columns_input {
  project_id: uuid!
}

# ---------------------------------------------------------------- project_file

type project_file {
  file_id: uuid!
  project_id: uuid!
  name: String!
  folder: String!
  content: String!
  is_binary: Boolean!
  created_at: timestamptz!
  updated_at: timestamptz!
  project: project
}

input project_file_bool_exp {
  _and: [project_file_bool_exp!]
  _or: [project_file_bool_exp!]
  _not: project_file_bool_exp
  file_id: uuid_comparison_exp
  project_id: uuid_comparison_exp
  name: String_comparison_exp
  folder: String_comparison_exp
  is_binary: Boolean_comparison_exp
  created_at: timestamptz_comparison_exp
  updated_at: timestamptz_comparison_exp
  project: project_bool_exp
}

input project_file_order_by {
  file_id: order_by
  name: order_by
  folder: order_by
  created_at: order_by
  updated_at: order_by
}

type project_file_aggregate {
  aggregate: project_file_aggregate_fields
}

type project_file_aggregate_fields {
  count: Int!
}

input project_file_set_input {
  name: String
  folder: String
  content: String
  is_binary: Boolean
}

input project_file_insert_input {
  project_id: uuid
  name: String
  folder: String
  content: String
  is_binary: Boolean
}

input project_file_arr_rel_insert_input {
  data: [project_file_insert_input!]!
}

input project_file_pk_columns_input {
  file_id: uuid!
}

# ---------------------------------------------------------------- project_star

type project_star {
  user_id: uuid!
  project_id: uuid!
  created_at: timestamptz
  user: user
  project: project
}

input project_star_bool_exp {
  _and: [project_star_bool_exp!]
  _or: [project_star_bool_exp!]
  _not: project_star_bool_exp
  user_id: uuid_comparison_exp
  project_id: uuid_comparison_exp
  created_at: timestamptz_comparison_exp
  user: user_bool_exp
  project: project_bool_exp
}

input project_star_order_by {
  user_id: order_by
  project_id: order_by
  created_at: order_by
}

input project_star_aggregate_order_by {
  count: order_by
}

type project_star_aggregate {
  aggregate: project_star_aggregate_fields
}

type project_star_aggregate_fields {
  count: Int!
}

input project_star_insert_input {
  project_id: uuid
}

type project_star_mutation_response {
  affected_rows: Int!
}

# ---------------------------------------------------------------- user_follows

type user_follows {
  follower_id: uuid!
  following_id: uuid!
  created_at: timestamptz
  follower: user
  following: user
}

input user_follows_bool_exp {
  _and: [user_follows_bool_exp!]
  _or: [user_follows_bool_exp!]
  _not: user_follows_bool_exp
  follower_id: uuid_comparison_exp
  following_id: uuid_comparison_exp
  created_at: timestamptz_comparison_exp
  follower: user_bool_exp
  following: user_bool_exp
}

input user_follows_order_by {
  follower_id: order_by
  following_id: order_by
  created_at: order_by
}

input user_follows_aggregate_order_by {
  count: order_by
}

type user_follows_aggregate {
  aggregate: user_follows_aggregate_fields
}

type user_follows_aggregate_fields {
  count: Int!
}

input user_follows_insert_input {
  follower_id: uuid
  following_id: uuid
}

type user_follows_mutation_response {
  affected_rows: Int!
}

# ---------------------------------------------------------------- session / role

type session {
  session_id: uuid!
  user_id: uuid!
  auth_token: String!
  created: timestamptz!
  updated: timestamptz
  expires: timestamptz!
  user: user
}

input session_bool_exp {
  _and: [session_bool_exp!]
  _or: [session_bool_exp!]
  _not: session_bool_exp
  session_id: uuid_comparison_exp
  user_id: uuid_comparison_exp
  auth_token: String_comparison_exp
  expires: timestamptz_comparison_exp
}

input session_order_by {
  created: order_by
  expires: order_by
}

input session_insert_input {
  user_id: uuid
  auth_token: String
  created: timestamptz
  expires: timestamptz
}

input session_set_input {
  updated: timestamptz
  expires: timestamptz
}

input session_pk_columns_input {
  session_id: uuid!
}

type role {
  role_id: uuid!
  name: String!
  created_at: timestamptz
}

type user_role {
  user_id: uuid!
  role_id: uuid!
  created_at: timestamptz
  user: user
  role: role
}

# ---------------------------------------------------------------- text

type text {
  text_id: uuid!
  name: String!
  lang: String!
  text: String!
  created_at: timestamptz!
  updated_at: timestamptz!
}

input text_bool_exp {
  _and: [text_bool_exp!]
  _or: [text_bool_exp!]
  _not: text_bool_exp
  text_id: uuid_comparison_exp
  name: String_comparison_exp
  lang: String_comparison_exp
}

input text_order_by {
  name: order_by
  lang: order_by
}

# ---------------------------------------------------------------- actions

input ProjectFileInput {
  name: String!
  content: String!
  is_binary: Boolean
}

type CompileResult {
  base64_encoded: String!
  sld: String
}

# ---------------------------------------------------------------- roots

type Query {
  user(where: user_bool_exp, order_by: [user_order_by!], limit: Int, offset: Int): [user!]!
  user_by_pk(user_id: uuid!): user
  user_aggregate(where: user_bool_exp): user_aggregate!
  project(where: project_bool_exp, order_by: [project_order_by!], limit: Int, offset: Int): [project!]!
  project_by_pk(project_id: uuid!): project
  project_aggregate(where: project_bool_exp): project_aggregate!
  project_file(where: project_file_bool_exp, order_by: [project_file_order_by!], limit: Int, offset: Int): [project_file!]!
  project_file_by_pk(file_id: uuid!): project_file
  project_star(where: project_star_bool_exp, order_by: [project_star_order_by!], limit: Int, offset: Int): [project_star!]!
  project_star_aggregate(where: project_star_bool_exp): project_star_aggregate!
  user_follows(where: user_follows_bool_exp, order_by: [user_follows_order_by!], limit: Int, offset: Int): [user_follows!]!
  user_follows_aggregate(where: user_follows_bool_exp): user_follows_aggregate!
  session(where: session_bool_exp, order_by: [session_order_by!], limit: Int, offset: Int): [session!]!
  text(where: text_bool_exp, order_by: [text_order_by!], limit: Int, offset: Int): [text!]!
}

type Mutation {
  insert_user_one(object: user_insert_input!): user
  update_user_by_pk(pk_columns: user_pk_columns_input!, _set: user_set_input): user
  update_user(where: user_bool_exp!, _set: user_set_input): user_mutation_response

  insert_project_one(object: project_insert_input!): project
  update_project_by_pk(pk_columns: project_pk_columns_input!, _set: project_set_input): project
  delete_project_by_pk(project_id: uuid!): project

  insert_project_file_one(object: project_file_insert_input!): project_file
  update_project_file_by_pk(pk_columns: project_file_pk_columns_input!, _set: project_file_set_input): project_file
  delete_project_file_by_pk(file_id: uuid!): project_file

  insert_project_star_one(object: project_star_insert_input!): project_star
  delete_project_star(where: project_star_bool_exp!): project_star_mutation_response

  insert_user_follows_one(object: user_follows_insert_input!): user_follows
  delete_user_follows(where: user_follows_bool_exp!): user_follows_mutation_response

  insert_session_one(object: session_insert_input!): session
  update_session_by_pk(pk_columns: session_pk_columns_input!, _set: session_set_input): session

  compile(basic: String!, files: [ProjectFileInput!]): CompileResult
  compileC(code: String!, files: [ProjectFileInput!]): CompileResult
  compileSjasmplus(code: String!, files: [ProjectFileInput!]): CompileResult
  compilePascal(code: String!, machine: String, files: [ProjectFileInput!]): CompileResult
}

type Subscription {
  project(where: project_bool_exp, order_by: [project_order_by!], limit: Int, offset: Int): [project!]!
}
`;
