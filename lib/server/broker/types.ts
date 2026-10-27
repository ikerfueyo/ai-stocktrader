// Alpaca Broker API object shapes, generated from the vendored OpenAPI spec (vendor/alpaca/broker-api.json) by
// `npm run gen:alpaca-types`. Fields are snake_case and decimal amounts are strings, exactly as Alpaca returns them, so the
// simulator (SimBroker) and the real API (AlpacaBroker) can share them.
import type { components, operations } from "./generated/brokerApi";

type Schemas = components["schemas"];

// Accounts and onboarding
export type Account = Schemas["Account"];
export type AccountExtended = Schemas["AccountExtended"];
export type AccountCreationRequest = Schemas["AccountCreationRequest"];
export type AccountUpdateRequest = Schemas["AccountUpdateRequest"];
export type AccountStatus = Schemas["AccountStatus"];
export type AccountType = Schemas["AccountType"];
export type AccountSubType = Schemas["AccountSubType"];
export type Contact = Schemas["Contact"];
export type Identity = Schemas["Identity"];
export type Disclosures = Schemas["Disclosures"];
export type Agreement = Schemas["Agreement"];
export type TrustedContact = Schemas["TrustedContact"];
export type KYCResults = Schemas["KYCResults"];
export type AccountStatusEvent = Schemas["AccountStatusEvent"];

// Trading account, configurations and limits
export type TradeAccount = Schemas["TradeAccount"];
export type AccountConfigurations = Schemas["AccountConfigurations"];
export type PortfolioHistory = Schemas["PortfolioHistory"];

// Assets and the market calendar
export type Asset = Schemas["Asset"];
export type CalendarDay = Schemas["legacy_calendar_day"];
export type Clock = Schemas["legacy_clock"];

// Orders and positions
export type Order = Schemas["Order"];
export type CreateOrderRequest = Schemas["CreateOrderRequest"];
export type UpdateOrderRequest = Schemas["UpdateOrderRequest"];
export type OrderStatus = Schemas["OrderStatus"];
export type OrderType = Schemas["OrderType"];
export type OrderSide = Schemas["OrderSide"];
export type OrderClass = Schemas["OrderClass"];
export type TimeInForce = Schemas["TimeInForce"];
export type PositionIntent = Schemas["PositionIntent"];
export type Position = Schemas["Position"];
export type TradeUpdateEvent = Schemas["TradeUpdateEventV2"];
export type TradeUpdateEventType = Schemas["TradeUpdateEventType"];

// Activities (the account ledger)
export type Activity = Schemas["Activity"];
export type ActivityType = Schemas["ActivityType"];
export type TradeActivity = Schemas["TradeActivity"];
export type NonTradeActivity = Schemas["NonTradeActivity"];

// Funding
export type ACHRelationship = Schemas["ACHRelationship"];
export type CreateACHRelationshipRequest = Schemas["CreateACHRelationshipRequest"];
export type Transfer = Schemas["Transfer"];
export type CreateTransferRequest = Schemas["CreateTransferRequest"];
export type TransferStatus = Schemas["TransferStatus"];
export type TransferStatusEvent = Schemas["TransferStatusEvent"];

// Documents
export type AccountDocument = Schemas["AccountDocument"];
export type AccountDocumentType = Schemas["AccountDocumentType"];
export type OwnerDocumentUploadRequest = Schemas["OwnerDocumentUploadRequest"];

// Options
export type OptionContract = Schemas["OptionContract"];
export type OptionsApprovalRequest = Schemas["OptionsApprovalRequest"];
export type OptionsApprovalResponse = Schemas["OptionsApprovalResponse"];

// Every error reply
export type BrokerErrorBody = Schemas["Error"];

// Query parameters of the list endpoints
export type ListOrdersQuery = NonNullable<operations["getAllOrdersForAccount"]["parameters"]["query"]>;
export type ListActivitiesQuery = NonNullable<operations["getAccountActivities"]["parameters"]["query"]>;
export type ListTransfersQuery = NonNullable<operations["getTransfersForAccount"]["parameters"]["query"]>;
export type ListDocumentsQuery = NonNullable<operations["getDocsForAccount"]["parameters"]["query"]>;
export type ListAssetsQuery = NonNullable<operations["getAssets"]["parameters"]["query"]>;
export type PortfolioHistoryQuery = NonNullable<operations["get-v1-trading-accounts-account_id-account-portfolio-history"]["parameters"]["query"]>;
