#include <QApplication>
#include "mywidget.h"

int main(int argc, char *argv[]) {
    QApplication app(argc, argv);
    MyWidget widget;
    widget.setWindowTitle("Qt5 LSP Test");
    widget.show();
    return app.exec();
}
