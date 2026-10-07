import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface UiState {
  selectedPackageId?: string
  packageSearch: string
  packageStatus: string
  materialCategory: string
  approvalRoundFilter: number | null
}

const initialState: UiState = {
  packageSearch: '',
  packageStatus: '',
  materialCategory: '',
  approvalRoundFilter: null,
}

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setSelectedPackage(state, action: PayloadAction<string | undefined>) {
      state.selectedPackageId = action.payload
    },
    setPackageSearch(state, action: PayloadAction<string>) {
      state.packageSearch = action.payload
    },
    setPackageStatus(state, action: PayloadAction<string>) {
      state.packageStatus = action.payload
    },
    setMaterialCategory(state, action: PayloadAction<string>) {
      state.materialCategory = action.payload
    },
    setApprovalRoundFilter(state, action: PayloadAction<number | null>) {
      state.approvalRoundFilter = action.payload
    },
  },
})

export const {
  setSelectedPackage,
  setPackageSearch,
  setPackageStatus,
  setMaterialCategory,
  setApprovalRoundFilter,
} = uiSlice.actions
export default uiSlice.reducer
