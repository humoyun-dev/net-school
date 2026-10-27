# MeshCentral (upstream)

`upstream/` — `Ylianst/MeshCentral` git submodule. Pin: [upstream.lock.json](upstream.lock.json) bilan bir xil commit bo'lishi shart.

## Lokal ishga tushirish

```bash
git submodule update --init
cd infra/meshcentral/upstream
npm install
node meshcentral --datapath ../../../meshcentral-data --port 8443 --redirport 8080
```

`meshcentral-data/` sertifikat va kalitlarni saqlaydi, u `.gitignore` da. Commit qilmang.

## Yangilash tartibi

Arxitektura §5.3: upstream review → alohida branch → adapter contract testlari → OS integratsiya testlari → bitta sinf canary.

1. Alohida branch oching.
2. `cd upstream && git fetch && git checkout <yangi-commit>`.
3. `upstream.lock.json` ni (commit, packageVersion) yangilang.
4. Testlardan keyin submodule o'zgarishini va lock faylni bitta commit qiling.

MeshCentral'ga o'zgartirish kerak bo'lsa, `upstream/` ni tahrirlamang: alohida `meshcentral-fork` da kichik commit qiling va submodule URL'ini shunga o'tkazing.
