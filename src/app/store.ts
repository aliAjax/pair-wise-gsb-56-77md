import { configureStore } from '@reduxjs/toolkit'
import { workspaceApi } from './api'
import uiReducer from './uiSlice'

export const store = configureStore({
  reducer: {
    [workspaceApi.reducerPath]: workspaceApi.reducer,
    ui: uiReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(workspaceApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
