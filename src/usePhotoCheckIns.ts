import { useEffect, useState } from "react";
import { PHOTO_CHECK_IN_EVENT, readPhotoCheckInPreferences, writePhotoCheckInPreferences, type PhotoCheckInPreferences } from "./photoCheckInModel";

export function usePhotoCheckInPreferences(): [PhotoCheckInPreferences, (next: PhotoCheckInPreferences) => void] {
  const [preferences, setPreferences] = useState(readPhotoCheckInPreferences);
  useEffect(() => {
    const update = (event: Event) => setPreferences((event as CustomEvent<PhotoCheckInPreferences>).detail ?? readPhotoCheckInPreferences());
    window.addEventListener(PHOTO_CHECK_IN_EVENT, update);
    return () => window.removeEventListener(PHOTO_CHECK_IN_EVENT, update);
  }, []);
  return [preferences, writePhotoCheckInPreferences];
}
