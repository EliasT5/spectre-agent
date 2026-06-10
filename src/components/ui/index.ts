/**
 * @spectre/ui — the shared instrument kit + declarative tab schema.
 * Import from here: `import { TabShell, Panel, Chip, SchemaTab, templates } from "@/components/ui"`.
 */
export * from "./kit";
export * from "./SchemaTab";
export * from "./SchemaRuntime";
export { ModuleFrame } from "./ModuleFrame";
// schema-v2 re-exports `Tone` from kit (same symbol); a blanket `export *` here
// would make `Tone` an ambiguous star-export and DROP it from the barrel. Use a
// named re-export of everything schema-v2 owns and let kit remain Tone's source.
export {
  resolvePath,
  resolveTemplate,
  resolveText,
  resolveNumber,
  evalWhen,
} from "./schema-v2";
export type {
  Val,
  WhenClause,
  SdkSource,
  ModuleSource,
  DataSource,
  SdkStep,
  RefetchStep,
  SetStateStep,
  NavigateStep,
  ModuleStep,
  ActionStep,
  ActionDef,
  PanelWidget,
  StatsWidget,
  ListWidget,
  MetricWidget,
  GaugeWidget,
  SegmentedWidget,
  ToggleWidget,
  ChipWidget,
  FormWidget,
  ActionRowWidget,
  ButtonWidget,
  NavWidget,
  EmptyWidget,
  LoadingWidget,
  ErrorWidget,
  TableWidget,
  ChartWidget,
  Widget,
  WidgetKind,
  UISchemaV2,
  Scope,
} from "./schema-v2";
