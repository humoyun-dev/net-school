import { useRemoteViewer } from './remote-panel.tsx';
import { RoomPage } from './room-page.tsx';

// Sinf sahifasi + remote viewer (plitkadagi "Ko'rish"/"Boshqarish" va bitta ochiq panel).
export function ClassroomRoute() {
  const viewer = useRemoteViewer();
  return (
    <>
      <RoomPage renderActions={viewer.actions} />
      {viewer.panel}
    </>
  );
}
