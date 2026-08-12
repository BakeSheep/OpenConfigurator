// Compatibility export for existing web consumers. Enum catalogs and pure
// lookup logic live in shared so the backend uses the same firmware scope.
export {
  parameterEnumLabel,
  parameterEnumOptions,
  parameterEnumValuesMatch,
  type ParameterEnumOption,
} from '../../shared/parameterEnumMetadata'
