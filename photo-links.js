const PRIVATE_PHOTO = /^https:\/\/res\.cloudinary\.com\/yl4yzjh5\/(?:image|video)\/authenticated\/(?!s--)/;

export function createAdminPhotoLinks(sign) {
  const cache = new Map();
  return {
    async prepare(urls) {
      const missing = [...new Set(urls.filter(url => PRIVATE_PHOTO.test(url) && !cache.has(url)))];
      for (let i = 0; i < missing.length; i += 100) {
        const batch = missing.slice(i, i + 100);
        const { data } = await sign({ urls: batch });
        batch.forEach((url, index) => {
          if (data.urls[index]) cache.set(url, data.urls[index]);
        });
      }
    },
    resolve(url) {
      return PRIVATE_PHOTO.test(url) ? cache.get(url) || "" : url;
    },
  };
}
